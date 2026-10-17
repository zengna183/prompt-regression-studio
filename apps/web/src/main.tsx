import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { SessionGate } from "./components/SessionGate";
import "./styles.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("找不到应用挂载节点 #root");
}

createRoot(rootElement).render(
  <StrictMode>
    <SessionGate />
  </StrictMode>,
);
