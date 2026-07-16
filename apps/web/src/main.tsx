import { ClerkProvider } from "@clerk/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element #root not found");
}

const publishableKey = import.meta.env["VITE_CLERK_PUBLISHABLE_KEY"];
if (!publishableKey) {
  throw new Error("VITE_CLERK_PUBLISHABLE_KEY is not set");
}

createRoot(rootElement).render(
  <StrictMode>
    <ClerkProvider publishableKey={publishableKey}>
      <App />
    </ClerkProvider>
  </StrictMode>,
);
