// Medlemsimport: CSV fra Excel/Klubmodul/Holdsport, kolonnegæt, forhåndsvisning, egne felter og tilbageeksport.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDb } from "./db";
import { loadAccessContext } from "../src/auth/context";
import { registerUser, createClub, runImport, detectMapping, parseDate, membersCsv, grantTreasurerByEmail } from "../src/services";
import { decodeCsvBytes, parseCsv } from "../src/lib/csv";
import { guardianships, memberFields, teamMembers, teams } from "../src/db/schema";
import { eq } from "drizzle-orm";

const { db, sql, reset } = testDb();
let clubId: string;
let admin: Awaited<ReturnType<typeof loadAccessContext>>;
const now = new Date("2026-11-02T12:00:00Z");

const FILE = [
  "Fornavn;Efternavn;Fødselsdato;E-mail;Mobil;Afdeling;Forælder;Forælder e-mail;Skostørrelse",
  "Anna;Hansen;12-03-2017;;;U9;Mette Hansen;mette@eks.dk;33",
  "Bo;Hansen;03.05.2015;;;U11, Svømning;Mette Hansen;mette@eks.dk;36",
  "Carl;Jensen;1985-06-01;carl@eks.dk;12345678;Veteran;;;",
].join("\r\n");

beforeAll(async () => {
  await reset();
  const u = await registerUser(db, "formand@imp.test", { firstName: "Fa", lastName: "Mand", birthDate: "1970-01-01" });
  clubId = (await createClub(db, await loadAccessContext(db, u.user.id, now), "Import IF", "import-if")).id;
  admin = await loadAccessContext(db, u.user.id, now);
});
afterAll(async () => {
  await sql.end();
});

describe("csv og kolonnegæt", () => {
  it("læser semikolon, komma, citationstegn og BOM", () => {
    expect(parseCsv('﻿a;b\r\n"x;1";"he said ""hi"""\r\n\r\n')).toEqual([["a", "b"], ["x;1", 'he said "hi"']]);
    expect(parseCsv("a,b\n1,2")).toEqual([["a", "b"], ["1", "2"]]);
  });
  it("genkender kolonner fra Klubmodul/Holdsport-lignende overskrifter og gør resten til egne felter", () => {
    const m = detectMapping(["Fornavn", "Efternavn", "Fødselsdato", "E-mail", "Mobilnr.", "Afdeling", "Forælder: navn", "Forælder: e-mail", "Medlemsnummer", "Status"]);
    expect(m.map((c) => c.target)).toEqual(["firstName", "lastName", "birthDate", "email", "phone", "team", "guardianName", "guardianEmail", "custom", "status"]);
    expect(detectMapping(["Navn", "Fødselsdato"]).map((c) => c.target)).toEqual(["fullName", "birthDate"]);
  });
  it("forstår danske datoer og afviser umulige", () => {
    expect(parseDate("31-12-2015")).toBe("2015-12-31");
    expect(parseDate("1.2.2015")).toBe("2015-02-01");
    expect(parseDate("2015-12-31")).toBe("2015-12-31");
    expect(parseDate("31-02-2015")).toBeNull();
    expect(parseDate("2999-01-01")).toBeNull();
    expect(parseDate("i går")).toBeNull();
  });
});

describe("tegnsæt", () => {
  it("læser både UTF-8 og dansk Excels Windows-1252", () => {
    const text = "Fødselsdato;Forælder\nÆbelø;Østergård";
    expect(decodeCsvBytes(new TextEncoder().encode(text))).toBe(text);
    const cp1252 = Uint8Array.from(text, (c) => ({ æ: 0xe6, ø: 0xf8, å: 0xe5, Æ: 0xc6, Ø: 0xd8, Å: 0xc5 })[c as "æ"] ?? c.charCodeAt(0));
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(cp1252)).toThrow();
    const decoded = decodeCsvBytes(cp1252);
    expect(decoded).toBe(text);
    expect(detectMapping(parseCsv(decoded)[0]).map((c) => c.target)).toEqual(["birthDate", "guardianName"]);
  });
});

describe("import", () => {
  it("viser forhåndsvisning uden at gemme noget", async () => {
    const r = await runImport(db, admin, clubId, FILE, null, false);
    expect(r.counts).toEqual({ new: 3, existing: 0, duplicate: 0, error: 0 });
    expect(r.newTeams.sort()).toEqual(["Svømning", "U11", "U9", "Veteran"]);
    expect((await db.select().from(teams).where(eq(teams.clubId, clubId))).length).toBe(0);
  });

  it("opretter medlemmer, forælder (delt mellem søskende), hold og egne felter", async () => {
    const r = await runImport(db, admin, clubId, FILE, null, true);
    expect(r.commit).toEqual({ created: 3, updated: 0, teamsCreated: 4 });
    const gs = await db.select().from(guardianships);
    expect(gs).toHaveLength(2);
    expect(new Set(gs.map((g) => g.guardianProfileId)).size).toBe(1);
    const t = await sql`select t.name from team_members tm join teams t on t.id = tm.team_id join profiles p on p.id = tm.profile_id where p.first_name = 'Bo' order by t.name`;
    expect(t.map((x) => x.name)).toEqual(["Svømning", "U11"]);
    expect((await db.select().from(memberFields)).map((f) => f.name)).toEqual(["Skostørrelse"]);
  });

  it("kan køres igen uden dubletter og overskriver ikke", async () => {
    const again = FILE.replace("Carl;Jensen;1985-06-01;carl@eks.dk;12345678", "Carl;Jensen;1985-06-01;ny@eks.dk;99999999");
    const pre = await runImport(db, admin, clubId, again, null, false);
    expect(pre.counts).toEqual({ new: 0, existing: 3, duplicate: 0, error: 0 });
    await runImport(db, admin, clubId, again, null, true);
    const rows = await sql`select email, phone from profiles where first_name = 'Carl'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: "carl@eks.dk", phone: "12345678" });
    expect(await db.select().from(guardianships)).toHaveLength(2);
    expect(await db.select().from(teamMembers)).toHaveLength(4);
  });

  it("nægter at gemme, når en række har fejl, og springer dubletter i filen over", async () => {
    const bad = "Fornavn;Efternavn;Fødselsdato;E-mail\nDitte;Dam;31-02-2015;x\nEmil;Eg;01-01-2000;emil@eks.dk\nEmil;Eg;01-01-2000;emil@eks.dk";
    const pre = await runImport(db, admin, clubId, bad, null, false);
    expect(pre.counts).toEqual({ new: 1, existing: 0, duplicate: 1, error: 1 });
    expect(pre.rows[0].errors).toHaveLength(2);
    await expect(runImport(db, admin, clubId, bad, null, true)).rejects.toThrow("Ret fejlene");
    expect(await sql`select 1 from profiles where first_name = 'Emil'`).toHaveLength(0);
  });

  it("kan bruge en kolonne med fulde navne og et rettet kolonnevalg", async () => {
    const file = "Medlem;Tlf\nFreja Fjord;11223344";
    const r = await runImport(db, admin, clubId, file, null, true);
    expect(r.commit?.created).toBe(1);
    const manual = await runImport(db, admin, clubId, "A;B\nGitte Gram;55", [{ target: "fullName" }, { target: "phone" }], false);
    expect(manual.rows[0].person).toMatchObject({ firstName: "Gitte", lastName: "Gram", phone: "55" });
  });

  it("slår ikke to forskellige forældre med samme navn sammen, og overskriver aldrig egne felter", async () => {
    const file = "Fornavn;Efternavn;Fødselsdato;Forælder;Forælder telefon;Skostørrelse\nOle;Olsen;01-01-2016;Anne Jensen;;30\nPer;Pedersen;02-02-2016;Anne Jensen;;31\nUlla;Ulsen;03-03-2016;Bente Bo;11111111;32\nUdo;Ulsen;04-04-2016;Bente Bo;11 11 11 11;33";
    await runImport(db, admin, clubId, file, null, true);
    const anne = await sql`select distinct g.guardian_profile_id from guardianships g join profiles c on c.id = g.child_profile_id where c.first_name in ('Ole','Per')`;
    expect(anne).toHaveLength(2);
    const bente = await sql`select distinct g.guardian_profile_id from guardianships g join profiles c on c.id = g.child_profile_id where c.first_name in ('Ulla','Udo')`;
    expect(bente).toHaveLength(1);
    await runImport(db, admin, clubId, file.replace(";30\n", ";99\n"), null, true);
    const shoe = await sql`select v.value from member_field_values v join profiles p on p.id = v.profile_id where p.first_name = 'Ole'`;
    expect(shoe[0].value).toBe("30");
  });

  it("kræver admin og kan eksporteres med egne felter", async () => {
    const other = await registerUser(db, "kasserer@imp.test", { firstName: "Ka", lastName: "Sserer" });
    await grantTreasurerByEmail(db, admin, clubId, "kasserer@imp.test");
    const treasurer = await loadAccessContext(db, other.user.id, now);
    await expect(runImport(db, treasurer, clubId, FILE, null, false)).rejects.toThrow();
    const csv = await membersCsv(db, treasurer, clubId);
    expect(csv).toContain("Skostørrelse");
    expect(csv).toContain("Anna;Hansen");
    expect(csv).toMatch(/;33\r?\n/);
  });
});

describe("dataflytning fra Klubmodul og Holdsport", () => {
  it("genkender statuskolonnen", () => {
    const h = ["Fulde navn", "Fødselsdato", "Status", "Holdnavn", "Mobiltelefon"];
    expect(detectMapping(h).map((c) => c.target)).toEqual(["fullName", "birthDate", "status", "team", "phone"]);
  });

  it("springer udmeldte over og melder det", async () => {
    const u = await registerUser(db, "flyt@imp.test", { firstName: "Fl", lastName: "Yt", birthDate: "1970-01-01" });
    const d = db;
    const ctx = await loadAccessContext(db, u.user.id, now);
    const clubId = (await createClub(db, ctx, "Flyt IF", "flyt-if")).id;
    const ctx2 = await loadAccessContext(db, u.user.id, now);
    const csv = "Navn;Fødselsdato;Status;Hold\nAnna Hansen;12-03-2015;Aktiv;U9\nBo Jensen;01-01-2014;Udmeldt;U9\nCarl Dam;02-02-2013;Aktiv;U11";
    const r = await runImport(d, ctx2, clubId, csv, null, true, "klubmodul");
    expect(r.inactive).toBe(1);
    expect(r.commit).toEqual({ created: 2, updated: 0, teamsCreated: 2 });
    const again = await runImport(d, ctx2, clubId, csv, null, false, "klubmodul");
    expect(again.counts).toEqual({ new: 0, existing: 2, duplicate: 0, error: 0 });
  });
});
