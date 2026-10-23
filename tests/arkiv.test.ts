// Dokumentarkivet mod en rigtig Postgres.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDb } from "./db";
import { seedDemo } from "../src/db/demo";
import { loadAccessContext } from "../src/auth/context";
import { ForbiddenError } from "../src/auth/permissions";
import { deleteDocument, getDocumentFile, listDocuments, replaceDocumentFile, sniffDocument, updateDocumentInfo, uploadDocument } from "../src/services";

const { db, sql, reset } = testDb();
let demo: Awaited<ReturnType<typeof seedDemo>>;
let clubId: string;
let u9: string;
let u11: string;

const pdf = (text = "x") => new TextEncoder().encode(`%PDF-1.4\n${text}`);
const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);

beforeAll(async () => {
  await reset();
  demo = await seedDemo(db);
  clubId = demo.club.id;
  u9 = demo.teams.u9.id;
  u11 = demo.teams.u11.id;
});
afterAll(async () => {
  await sql.end();
});

const ctxOf = (key: keyof typeof demo.users) => loadAccessContext(db, demo.users[key].user.id);
const titles = async (who: keyof typeof demo.users) => (await listDocuments(db, await ctxOf(who))).map((d) => d.title).sort();

describe("filtyper", () => {
  it("genkender filer på indholdet", () => {
    expect(sniffDocument(pdf(), "a.pdf")).toBe("application/pdf");
    expect(sniffDocument(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), "a.jpg")).toBe("image/jpeg");
    expect(sniffDocument(zip, "regler.docx")).toContain("wordprocessingml");
    expect(sniffDocument(zip, "tal.xlsx")).toContain("spreadsheetml");
    // En zip-fil med en anden endelse, og en tekstfil med pdf-endelse, afvises.
    expect(sniffDocument(zip, "program.zip")).toBeNull();
    expect(sniffDocument(new TextEncoder().encode("<script>alert(1)</script>"), "a.pdf")).toBeNull();
    expect(sniffDocument(new TextEncoder().encode("<svg onload=alert(1)>"), "a.svg")).toBeNull();
  });
});

describe("dokumentarkiv", () => {
  it("lader admin og kasserer lægge op til foreningen, og trænere til eget hold", async () => {
    await uploadDocument(db, await ctxOf("karen"), clubId, { audience: "club", title: "Vedtægter", category: "Vedtægter", fileName: "vedtaegter.pdf", bytes: pdf() });
    await uploadDocument(db, await ctxOf("sofie"), clubId, { audience: "board", title: "Budget 2027", fileName: "budget.xlsx", bytes: zip });
    await uploadDocument(db, await ctxOf("mette"), clubId, { audience: "team", teamId: u9, title: "Turneringsregler U9", fileName: "regler.pdf", bytes: pdf() });
    await uploadDocument(db, await ctxOf("jonas"), clubId, { audience: "team", teamId: u11, title: "Kørselsliste U11", fileName: "kor.pdf", bytes: pdf() });
  });

  it("afviser upload fra dem, der ikke må", async () => {
    const base = { fileName: "a.pdf", bytes: pdf(), title: "X" };
    await expect(uploadDocument(db, await ctxOf("ali"), clubId, { ...base, audience: "club" })).rejects.toBeInstanceOf(ForbiddenError);
    // Mette er træner på U9, ikke U11, og ikke admin.
    await expect(uploadDocument(db, await ctxOf("mette"), clubId, { ...base, audience: "team", teamId: u11 })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(uploadDocument(db, await ctxOf("mette"), clubId, { ...base, audience: "club" })).rejects.toBeInstanceOf(ForbiddenError);
    // Kassereren lægger ikke op til et hold.
    await expect(uploadDocument(db, await ctxOf("sofie"), clubId, { ...base, audience: "team", teamId: u9 })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("afviser ugyldige filer, tomme titler og for store filer", async () => {
    const karen = await ctxOf("karen");
    const base = { audience: "club" as const, fileName: "a.pdf", title: "X" };
    await expect(uploadDocument(db, karen, clubId, { ...base, bytes: new Uint8Array() })).rejects.toThrow(/Vælg en fil/);
    await expect(uploadDocument(db, karen, clubId, { ...base, bytes: new TextEncoder().encode("hej") })).rejects.toThrow(/PDF/);
    await expect(uploadDocument(db, karen, clubId, { ...base, title: " ", bytes: pdf() })).rejects.toThrow(/titel/);
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(pdf());
    await expect(uploadDocument(db, karen, clubId, { ...base, bytes: big })).rejects.toThrow(/10 MB/);
  });

  it("viser hver målgruppe de rigtige dokumenter", async () => {
    // Admin ser alt. Kassereren ser foreningens og bestyrelsens.
    expect(await titles("karen")).toEqual(["Budget 2027", "Kørselsliste U11", "Turneringsregler U9", "Vedtægter"]);
    // Sofie er også forælder til Ida (U9) og Lukas (U11), så hun ser begge holds dokumenter.
    expect(await titles("sofie")).toEqual(["Budget 2027", "Kørselsliste U11", "Turneringsregler U9", "Vedtægter"]);
    // Mette (træner U9): foreningen og eget hold. Ali (forælder på U9): det samme, ikke bestyrelsen eller U11.
    expect(await titles("mette")).toContain("Turneringsregler U9");
    expect(await titles("mette")).not.toContain("Budget 2027");
    expect(await titles("ali")).toEqual(["Turneringsregler U9", "Vedtægter"]);
    // Jonas træner U11 og ser U11-dokumentet, ikke U9's.
    expect(await titles("jonas")).toContain("Kørselsliste U11");
    expect(await titles("jonas")).not.toContain("Turneringsregler U9");
  });

  it("holder filen tilbage for dem, der ikke må se dokumentet", async () => {
    const docs = await listDocuments(db, await ctxOf("karen"));
    const budget = docs.find((d) => d.title === "Budget 2027")!;
    const regler = docs.find((d) => d.title === "Turneringsregler U9")!;
    await expect(getDocumentFile(db, await ctxOf("ali"), budget.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getDocumentFile(db, await ctxOf("mette"), budget.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getDocumentFile(db, await ctxOf("jonas"), regler.id)).rejects.toBeInstanceOf(ForbiddenError);
    const file = await getDocumentFile(db, await ctxOf("ali"), regler.id);
    expect(file.contentType).toBe("application/pdf");
    expect(file.fileName).toBe("regler.pdf");
    expect(Buffer.from(file.data).toString().startsWith("%PDF")).toBe(true);
  });

  it("giver kun ledelsen lov at rette, erstatte og slette, og tæller versioner", async () => {
    const regler = (await listDocuments(db, await ctxOf("mette"))).find((d) => d.title === "Turneringsregler U9")!;
    expect(regler.canManage).toBe(true);
    expect((await listDocuments(db, await ctxOf("ali"))).find((d) => d.id === regler.id)!.canManage).toBe(false);
    await expect(deleteDocument(db, await ctxOf("ali"), regler.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(replaceDocumentFile(db, await ctxOf("ali"), regler.id, { fileName: "x.pdf", bytes: pdf() })).rejects.toBeInstanceOf(ForbiddenError);
    await replaceDocumentFile(db, await ctxOf("mette"), regler.id, { fileName: "regler-2.pdf", bytes: pdf("ny") });
    await expect(replaceDocumentFile(db, await ctxOf("mette"), regler.id, { fileName: "x.exe", bytes: new TextEncoder().encode("MZ") })).rejects.toThrow(/PDF/);
    await updateDocumentInfo(db, await ctxOf("mette"), regler.id, { title: "Turneringsregler U9 2027", category: "Regler" });
    const after = (await listDocuments(db, await ctxOf("ali"))).find((d) => d.id === regler.id)!;
    expect(after).toMatchObject({ version: 2, fileName: "regler-2.pdf", title: "Turneringsregler U9 2027", category: "Regler" });
  });

  it("sletter filen, så den ikke kan hentes mere", async () => {
    const doc = (await listDocuments(db, await ctxOf("karen"))).find((d) => d.title === "Kørselsliste U11")!;
    await deleteDocument(db, await ctxOf("jonas"), doc.id);
    expect((await titles("karen"))).not.toContain("Kørselsliste U11");
    await expect(getDocumentFile(db, await ctxOf("karen"), doc.id)).rejects.toThrow(/findes ikke/);
    const [row] = await sql`select size, length(data) as n from club_documents where id = ${doc.id}`;
    expect(Number(row.size)).toBe(0);
    expect(Number(row.n)).toBe(0);
  });

  it("holder foreningens arkiv adskilt fra andre foreninger", async () => {
    const { createClub, registerUser } = await import("../src/services");
    const u = await registerUser(db, "bestyrelse@anden.test", { firstName: "Bo", lastName: "Anden" });
    const other = await createClub(db, await loadAccessContext(db, u.user.id), "Anden IF", "anden-if");
    await uploadDocument(db, await loadAccessContext(db, u.user.id), other.id, { audience: "club", title: "Hemmeligt", fileName: "h.pdf", bytes: pdf() });
    expect(await titles("karen")).not.toContain("Hemmeligt");
    expect((await listDocuments(db, await loadAccessContext(db, u.user.id))).map((d) => d.title)).toEqual(["Hemmeligt"]);
  });
});
