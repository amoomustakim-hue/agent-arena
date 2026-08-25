import { loadSession } from "@/lib/session";
import WarRoom from "@/components/WarRoom";

export default async function Page() {
  const events = await loadSession();
  return <WarRoom events={events} />;
}
