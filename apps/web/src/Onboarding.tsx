import type { L1, OnboardingRequest } from "@kalli/types";
import { L1_VALUES } from "@kalli/types";
import { useAuth } from "@clerk/react";
import { useState } from "react";

const L1_LABELS: Record<L1, string> = {
  spanish: "Spanish",
  mandarin: "Mandarin Chinese",
  vietnamese: "Vietnamese",
  korean: "Korean",
  arabic: "Arabic",
  other: "Other",
};

type Step = "l1" | "consent";

export function Onboarding({ onComplete }: { onComplete: () => void }) {
  const { getToken } = useAuth();
  const [step, setStep] = useState<Step>("l1");
  const [l1, setL1] = useState<L1 | null>(null);
  const [consented, setConsented] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submitOnboarding() {
    if (!l1 || !consented) return;

    setSubmitting(true);
    setError(null);

    try {
      const token = await getToken();
      const apiUrl = import.meta.env["VITE_API_URL"] ?? "";
      const body: OnboardingRequest = { l1, consent: true };
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

  if (step === "l1") {
    return (
      <main>
        <h1>What's your native language?</h1>
        <p>Kalli uses this to watch for mistakes common to speakers of your language.</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setStep("consent");
          }}
        >
          {L1_VALUES.map((value) => (
            <label key={value}>
              <input
                type="radio"
                name="l1"
                value={value}
                checked={l1 === value}
                onChange={() => setL1(value)}
              />
              {L1_LABELS[value]}
            </label>
          ))}
          <button type="submit" disabled={!l1}>
            Continue
          </button>
        </form>
      </main>
    );
  }

  return (
    <main>
      <h1>Recording consent</h1>
      <p>
        To give you feedback, Kalli records short clips of your voice around any mistakes she flags
        and stores them for up to 90 days. This is separate from our general terms of service.
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
