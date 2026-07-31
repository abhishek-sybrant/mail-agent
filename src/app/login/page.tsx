import { Suspense } from "react";
import { Bot } from "lucide-react";
import { LoginForm } from "./login-form";

export default function LoginPage() {
  return (
    <div className="flex min-h-screen w-full items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <Bot className="text-primary size-8" />
          <h1 className="text-xl font-semibold">AI SDR Dashboard</h1>
          <p className="text-muted-foreground text-sm">
            Sign in to manage campaigns and approvals.
          </p>
        </div>
        <Suspense>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  );
}
