import { redirect } from "next/navigation";

/**
 * The platform has no public landing page. Everything lives behind the
 * sign-in, so the root sends you to your dashboard, and the proxy sends you to
 * the sign-in form if you are not authenticated yet.
 */
export default function RootPage() {
  redirect("/dashboard");
}
