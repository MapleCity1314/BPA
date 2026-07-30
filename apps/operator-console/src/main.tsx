import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { HttpOperatorConsoleApi } from "./api.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Operator Console root element is missing");

createRoot(root).render(
  <StrictMode>
    <App api={new HttpOperatorConsoleApi()} />
  </StrictMode>
);
