export interface AuthMeResponse {
  userId: string;
}

/** Native languages with dedicated interference-pattern hints (ticket 09). Other L1s use "other". */
export const SUPPORTED_L1S = ["spanish", "mandarin", "vietnamese", "korean", "arabic"] as const;

export type SupportedL1 = (typeof SUPPORTED_L1S)[number];

export type L1 = SupportedL1 | "other";

export const L1_VALUES = [...SUPPORTED_L1S, "other"] as const;

export interface OnboardingStatusResponse {
  l1: L1 | null;
  consentGivenAt: string | null;
}

export interface OnboardingRequest {
  l1: L1;
  consent: boolean;
}
