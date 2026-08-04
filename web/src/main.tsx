import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { bootstrapSession } from "./lib/api";
import { createQueryClient } from "./lib/queryClient";
import "./index.css";

const queryClient = createQueryClient();

// Resolve the session before first paint of any guarded route. The route guard
// renders a "loading" state until this settles, so a reload keeps its deep link.
void bootstrapSession();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
