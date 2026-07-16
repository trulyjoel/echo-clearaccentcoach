import { Show, SignIn } from "@clerk/react";
import { Home } from "./Home.js";

export function App() {
  return (
    <>
      <Show when="signed-out">
        <SignIn />
      </Show>
      <Show when="signed-in">
        <Home />
      </Show>
    </>
  );
}
