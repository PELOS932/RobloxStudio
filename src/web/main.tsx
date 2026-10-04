import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";
import { convertHtmlToUi } from "./lib/html-to-ui.ts";

// Handy for debugging translations from the devtools console: await __forge.convertHtmlToUi(html, {...}).
(window as unknown as { __forge: unknown }).__forge = { convertHtmlToUi };

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
