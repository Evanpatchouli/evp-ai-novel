import React from "react";
import ReactDOM from "react-dom/client";
import { ThemeProvider, ToastProvider } from "@ldkj/web-ui";
import "@ldkj/web-ui/reset.css";
import "@ldkj/web-ui/style.css";
import "./styles.css";
import { App } from "./App";
import {
  AppearanceProvider,
  applyAppearanceToRoot,
  readStoredAppearance,
  useAppearance,
} from "./app/appearance";
import { workbenchThemes } from "./app/theme";

const initialAppearance = readStoredAppearance();
applyAppearanceToRoot(document.documentElement, initialAppearance);

function ThemedWorkbench() {
  const { appearance } = useAppearance();

  return (
    <ThemeProvider
      theme={workbenchThemes[appearance]}
      mode={appearance === "modern" ? "dark" : "light"}
      scope="root"
    >
      <ToastProvider>
        <App />
      </ToastProvider>
    </ThemeProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppearanceProvider initialAppearance={initialAppearance}>
      <ThemedWorkbench />
    </AppearanceProvider>
  </React.StrictMode>,
);
