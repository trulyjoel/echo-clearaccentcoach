import type { OnboardingStatusResponse } from "@callie/types";
import { useAuth } from "@clerk/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Home } from "./Home.js";
import { Onboarding } from "./Onboarding.js";

type OnboardingState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "incomplete" }
  | { status: "complete" };

function isOnboarded(response: OnboardingStatusResponse): boolean {
  return response.l1 !== null && response.consentGivenAt !== null;
}

export function AuthenticatedApp() {
  const { getToken } = useAuth();
  const [state, setState] = useState<OnboardingState>({ status: "loading" });
  const unmountedRef = useRef(false);

  useEffect(() => {
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  const loadOnboardingStatus = useCallback(async () => {
    setState({ status: "loading" });

    try {
      const token = await getToken();
      const apiUrl = import.meta.env["VITE_API_URL"] ?? "";
      const response = await fetch(`${apiUrl}/api/onboarding`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });

      if (unmountedRef.current) return;

      if (!response.ok) {
        setState({ status: "error" });
        return;
      }

      const data = (await response.json()) as OnboardingStatusResponse;
      setState({ status: isOnboarded(data) ? "complete" : "incomplete" });
    } catch {
      if (!unmountedRef.current) setState({ status: "error" });
    }
  }, [getToken]);

  useEffect(() => {
    void loadOnboardingStatus();
  }, [loadOnboardingStatus]);

  if (state.status === "loading") return <p>Loading...</p>;
  if (state.status === "error") return <p>Couldn't load your account.</p>;
  if (state.status === "incomplete") {
    return <Onboarding onComplete={() => void loadOnboardingStatus()} />;
  }

  return <Home />;
}
