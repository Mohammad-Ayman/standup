export function GET(): Response {
  return Response.json({ ok: true, service: "standup-web" });
}
