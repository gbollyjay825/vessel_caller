import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { initializeFrontendMonitoring } from "./lib/sentry";
import "./index.css";
import "./styles/app.css";
import "./styles/landing.css";

// Runtime configuration is intentionally asynchronous so the same immutable
// bundle can be promoted unchanged. Monitoring failure never blocks rendering.
void initializeFrontendMonitoring();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js");
  });
}
