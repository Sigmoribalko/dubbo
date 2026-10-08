import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { store } from "./lib/store";
import { notify } from "./state/app";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/motion.css";

store.onWarning = notify;

if (import.meta.env.DEV) {
  // Handles for poking at the app from the devtools console.
  Promise.all([import("./state/app"), import("./state/game"), import("./lib/audio/engine"), import("./lib/pack/import")]).then(
    ([app, game, engine, pack]) => Object.assign(window, { __dubl: { ...app, ...game, ...engine, ...pack, store } }),
  );
}

store.init().then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
