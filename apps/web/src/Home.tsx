import type { AuthMeResponse } from "@kalli/types";
import { useAuth, UserButton } from "@clerk/react";
import { useEffect, useState } from "react";
import { History } from "./History.js";
import { Session } from "./Session.js";

type MeState = { status: "loading" } | { status: "error" } | { status: "ok"; userId: string };
type View = "practice" | "history";

export function Home() {
  const { getToken } = useAuth();
  const [me, setMe] = useState<MeState>({ status: "loading" });
  const [view, setView] = useState<View>("practice");

  useEffect(() => {
    let cancelled = false;

    async function loadMe() {
      try {
        const token = await getToken();
        const apiUrl = import.meta.env["VITE_API_URL"] ?? "";
        const response = await fetch(`${apiUrl}/api/me`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });

        if (cancelled) return;

        if (!response.ok) {
          setMe({ status: "error" });
          return;
        }

        const data = (await response.json()) as AuthMeResponse;
        setMe({ status: "ok", userId: data.userId });
      } catch {
        if (!cancelled) setMe({ status: "error" });
      }
    }

    void loadMe();

    return () => {
      cancelled = true;
    };
  }, [getToken]);

  return (
    <main>
      <h1>Kalli</h1>
      <UserButton />
      {me.status === "loading" && <p>Loading...</p>}
      {me.status === "error" && <p>Couldn't load your account.</p>}
      {me.status === "ok" && <p>Signed in as {me.userId}</p>}
      <button onClick={() => setView(view === "practice" ? "history" : "practice")}>
        {view === "practice" ? "View history" : "Back to practice"}
      </button>
      {view === "practice" ? <Session /> : <History />}
    </main>
  );
}
