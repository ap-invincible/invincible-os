import React from "react";
import ReactDOM from "react-dom/client";
import { ConvexReactClient } from "convex/react";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { App } from "./App";
import "./styles.css";

const url = import.meta.env.VITE_CONVEX_URL;
if (!url) throw new Error("Missing VITE_CONVEX_URL. Copy .env.example to .env.local.");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><ConvexAuthProvider client={new ConvexReactClient(url)}><App /></ConvexAuthProvider></React.StrictMode>,
);
