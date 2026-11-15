import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { LiveProvider } from "./live";
import Agent from "./pages/Agent";
import Architecture from "./pages/Architecture";
import Compare from "./pages/Compare";
import Gateway from "./pages/Gateway";
import Live from "./pages/Live";
import Overview from "./pages/Overview";
import Results from "./pages/Results";
import Run from "./pages/Run";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <LiveProvider>
        <Layout>
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/architecture" element={<Architecture />} />
            <Route path="/run" element={<Run />} />
            <Route path="/live" element={<Live />} />
            <Route path="/results" element={<Results />} />
            <Route path="/results/:id" element={<Results />} />
            <Route path="/compare" element={<Compare />} />
            <Route path="/gateway" element={<Gateway />} />
            <Route path="/agent" element={<Agent />} />
          </Routes>
        </Layout>
      </LiveProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
