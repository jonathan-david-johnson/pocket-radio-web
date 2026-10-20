import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import AppRoot from "./AppRoot";
import "./style.css";

const container = document.getElementById("root");
if (!container) throw new Error("Missing root element");

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <AppRoot />
    </BrowserRouter>
  </StrictMode>,
);
