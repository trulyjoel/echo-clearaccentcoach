import { Show, SignIn } from "@clerk/react";
import { AuthenticatedApp } from "./AuthenticatedApp.js";

export function App() {
  return (
    <>
      <Show when="signed-out">
        <SignIn />
      </Show>
      <Show when="signed-in">
        <AuthenticatedApp />
      </Show>
    </>
  );
}
