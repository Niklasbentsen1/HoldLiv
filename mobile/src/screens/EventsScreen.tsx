import { useCallback, useEffect, useState } from "react";
import { FlatList, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { api, ApiError, type EventItem, type Person, type Status } from "../api";
import { colors } from "../theme";
import { Button, Card, ErrorText } from "../ui";

const when = (iso: string) => new Date(iso).toLocaleString("da-DK", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const LABEL: Record<Status, string> = { yes: "Kommer", maybe: "Måske", no: "Kommer ikke" };
const COLOR: Record<Status, string> = { yes: colors.yes, maybe: colors.maybe, no: colors.no };

/** Kommende aktiviteter for en selv eller et barn, med svar ja/måske/nej. */
export function EventsScreen({ people, onUnauthorized }: { people: Person[]; onUnauthorized: () => void }) {
  const [who, setWho] = useState(people[0]?.id ?? "");
  const [events, setEvents] = useState<EventItem[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!who) return;
    try {
      setEvents((await api.events(who)).events);
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return onUnauthorized();
      setError(e instanceof ApiError ? e.message : "Noget gik galt.");
    }
  }, [who, onUnauthorized]);

  useEffect(() => {
    setEvents(null);
    load();
  }, [load]);

  async function answer(ev: EventItem, status: Status) {
    const before = events;
    setEvents((list) => list?.map((x) => (x.id === ev.id ? { ...x, status } : x)) ?? null); // vises med det samme
    try {
      await api.respond(ev.id, who, status);
    } catch (e) {
      setEvents(before);
      setError(e instanceof ApiError ? e.message : "Svaret blev ikke gemt.");
    }
  }

  return (
    <View style={s.root}>
      {people.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.people}>
          {people.map((p) => (
            <Button key={p.id} title={p.self ? "Mig" : p.name.split(" ")[0]} kind={p.id === who ? "primary" : "plain"} onPress={() => setWho(p.id)} style={{ minHeight: 40 }} />
          ))}
        </ScrollView>
      )}
      <ErrorText message={error} />
      <FlatList
        data={events ?? []}
        keyExtractor={(e) => e.id}
        contentContainerStyle={{ gap: 12, padding: 16 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
        ListEmptyComponent={<Text style={s.muted}>{events === null ? "Henter…" : "Ingen kommende aktiviteter."}</Text>}
        renderItem={({ item: ev }) => (
          <Card>
            <Text style={s.team}>{ev.teamName}</Text>
            <Text style={s.title}>{ev.title}</Text>
            <Text style={s.muted}>{when(ev.startsAt)}{ev.location ? ` · ${ev.location}` : ""}</Text>
            {ev.cancelledAt ? (
              <Text style={{ color: colors.danger, fontWeight: "700" }}>Aflyst</Text>
            ) : (
              <View style={s.row}>
                {(["yes", "maybe", "no"] as Status[]).map((st) => (
                  <Button key={st} title={LABEL[st]} kind={ev.status === st ? "primary" : "plain"} onPress={() => answer(ev, st)} style={[{ flex: 1, minHeight: 40, paddingHorizontal: 8 }, ev.status === st ? { backgroundColor: COLOR[st] } : {}] as never} />
                ))}
              </View>
            )}
          </Card>
        )}
      />
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  people: { gap: 8, padding: 16 },
  team: { color: colors.primary, fontWeight: "700", fontSize: 12 },
  title: { fontSize: 18, fontWeight: "700", color: colors.text },
  muted: { color: colors.muted },
  row: { flexDirection: "row", gap: 8, marginTop: 4 },
});
