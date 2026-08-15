import type { CategoryFrequency, SessionErrorsResponse, SessionSummary } from "@kalli/types";
import { useAuth } from "@clerk/react";
import { useEffect, useState } from "react";
import { apiFetch } from "./api.js";
import { CATEGORY_LABELS } from "./errorCategoryLabels.js";

type SessionsState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ok"; sessions: SessionSummary[] };

type SummaryState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ok"; frequencies: CategoryFrequency[] };

type SelectedSessionState =
  | { status: "none" }
  | { status: "loading"; sessionId: string }
  | { status: "error"; sessionId: string }
  | { status: "ok"; data: SessionErrorsResponse };

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { timeZone: "UTC" });
}

function formatDuration(session: SessionSummary): string {
  if (!session.endedAt) return "In progress";
  const ms = new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime();
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

async function fetchJson<T>(path: string, token: string | null): Promise<T> {
  const response = await apiFetch(path, token);
  return (await response.json()) as T;
}

function ErrorSummary({ summary }: { summary: SummaryState }) {
  if (summary.status === "loading") return <p>Loading summary...</p>;
  if (summary.status === "error") return <p role="alert">Couldn't load your error summary.</p>;
  if (summary.frequencies.length === 0) return <p>No errors recorded yet.</p>;

  return (
    <ul aria-label="Error frequency by category">
      {summary.frequencies.map((frequency) => (
        <li key={frequency.category}>
          {CATEGORY_LABELS[frequency.category]}: {frequency.count}
        </li>
      ))}
    </ul>
  );
}

function SessionErrorList({ selected }: { selected: SelectedSessionState }) {
  if (selected.status === "none") return null;
  if (selected.status === "loading") return <p>Loading session...</p>;
  if (selected.status === "error") return <p role="alert">Couldn't load that session's errors.</p>;

  const { errors } = selected.data;
  return (
    <section aria-label="Session errors">
      {errors.length === 0 ? (
        <p>No errors flagged in this session.</p>
      ) : (
        <ul>
          {errors.map((error) => (
            <li key={error.id}>
              <strong>{CATEGORY_LABELS[error.category]}</strong>
              <p>
                <span>{error.original}</span> → <span>{error.corrected}</span>
              </p>
              <p>{error.explanation}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function History() {
  const { getToken } = useAuth();
  const [sessions, setSessions] = useState<SessionsState>({ status: "loading" });
  const [summary, setSummary] = useState<SummaryState>({ status: "loading" });
  const [selected, setSelected] = useState<SelectedSessionState>({ status: "none" });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const token = await getToken();
      try {
        const data = await fetchJson<SessionSummary[]>("/api/history/sessions", token);
        if (!cancelled) setSessions({ status: "ok", sessions: data });
      } catch (error) {
        console.error("Failed to load session history", error);
        if (!cancelled) setSessions({ status: "error" });
      }
      try {
        const data = await fetchJson<CategoryFrequency[]>("/api/history/errors/summary", token);
        if (!cancelled) setSummary({ status: "ok", frequencies: data });
      } catch (error) {
        console.error("Failed to load error-frequency summary", error);
        if (!cancelled) setSummary({ status: "error" });
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [getToken]);

  async function selectSession(sessionId: string): Promise<void> {
    setSelected({ status: "loading", sessionId });
    try {
      const token = await getToken();
      const data = await fetchJson<SessionErrorsResponse>(
        `/api/history/sessions/${sessionId}/errors`,
        token,
      );
      setSelected({ status: "ok", data });
    } catch (error) {
      console.error("Failed to load session errors", error);
      setSelected({ status: "error", sessionId });
    }
  }

  return (
    <section aria-label="History">
      <h2>Your progress</h2>
      <ErrorSummary summary={summary} />

      {sessions.status === "loading" && <p>Loading sessions...</p>}
      {sessions.status === "error" && <p role="alert">Couldn't load your session history.</p>}
      {sessions.status === "ok" && (
        <ul aria-label="Past sessions">
          {sessions.sessions.map((session) => (
            <li key={session.id}>
              <time dateTime={session.startedAt}>{formatDate(session.startedAt)}</time>
              {" — "}
              {formatDuration(session)}
              {" — "}
              {session.turnCount} turns, {session.errorCount} errors
              <button onClick={() => void selectSession(session.id)}>
                View errors from {formatDate(session.startedAt)}
              </button>
            </li>
          ))}
        </ul>
      )}

      <SessionErrorList selected={selected} />
    </section>
  );
}
