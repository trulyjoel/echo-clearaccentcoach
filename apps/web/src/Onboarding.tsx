import type { OnboardingRequest } from "@kalli/types";
import { useAuth } from "@clerk/react";
import { useState } from "react";

export function Onboarding({ onComplete }: { onComplete: () => void }) {
  const { getToken } = useAuth();
  const [consented, setConsented] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submitOnboarding() {
    if (!consented) return;

    setSubmitting(true);
    setError(null);

    try {
      const token = await getToken();
      const apiUrl = import.meta.env["VITE_API_URL"] ?? "";
      const body: OnboardingRequest = { consent: true };
      const response = await fetch(`${apiUrl}/api/onboarding`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        setError("Couldn't save your preferences. Try again.");
        return;
      }

      onComplete();
    } catch {
      setError("Couldn't save your preferences. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main>
      <h1>Recording consent</h1>
      <p>
        To give you feedback, Kalli records short clips of your voice around any mistakes she flags
        and stores them for up to 90 days. This is separate from our general terms of service.
        Kalli will also ask you a few quick questions by voice once you start your first session —
        your name, native language, and what you'd like to work on.
      </p>
      <label>
        <input
          type="checkbox"
          checked={consented}
          onChange={(event) => setConsented(event.target.checked)}
        />
        I consent to my voice being recorded and stored for this purpose.
      </label>
      {error && <p role="alert">{error}</p>}
      <button
        type="button"
        onClick={() => void submitOnboarding()}
        disabled={!consented || submitting}
      >
        Start practicing
      </button>
    </main>
  );
}
