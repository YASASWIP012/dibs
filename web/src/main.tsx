import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles/foundation.css";
import "./styles/brand.css";
import "./styles/app.css";
import { Landing } from "./pages/Landing";
import { Studio } from "./pages/Studio";
import { Room } from "./pages/Room";
import { Demo } from "./pages/Demo";

export function navigate(to: string) {
  history.pushState(null, "", to);
  dispatchEvent(new PopStateEvent("popstate"));
}

function App() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    addEventListener("popstate", on);
    return () => removeEventListener("popstate", on);
  }, []);
  const room = path.match(/^\/s\/([\w-]+)/);
  if (room) return <Room showId={room[1]!} />;
  if (path.startsWith("/studio")) return <Studio />;
  if (path.startsWith("/demo")) return <Demo />;
  return <Landing />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
