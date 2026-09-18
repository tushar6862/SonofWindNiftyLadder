import { Redirect, Route, Switch } from "wouter";
import { useAuth } from "@/auth/AuthContext";
import DashboardPage from "@/pages/Dashboard";
import FyersCallbackPage from "@/pages/FyersCallback";
import LoginPage from "@/pages/Login";
import NotFound from "@/pages/not-found";
import React from "react";

function PrivateRoute({ component: Component }: { component: () => React.ReactElement }) {
  const { state } = useAuth();
  if (state.status === "loading") return <div className="min-h-screen bg-background" />;
  if (state.status !== "authed") return <Redirect to="/login" />;
  return <Component />;
}

export default function App() {
  return (
    <Switch>
      <Route path="/login" component={LoginPage} />
      <Route path="/fyers/callback" component={FyersCallbackPage} />
      <Route path="/">
        <PrivateRoute component={DashboardPage} />
      </Route>
      <Route>
        <NotFound />
      </Route>
    </Switch>
  );
}
