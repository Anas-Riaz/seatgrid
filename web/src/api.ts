/** Thin client for the SeatGrid REST API (all calls go through the NGINX gateway). */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Session {
  username: string;
  isAdmin: boolean;
  token: string;
}

export interface EventSummary {
  event_id: number;
  title: string;
  tournament: string;
  venue: string;
  city: string;
  start_time: string;
  base_price: number;
  available_seats: number;
}

export interface SectionInfo {
  sectionId: number;
  name: string;
  className: string;
  seatCount: number;
  price: number | null;
  available: number;
  total: number;
}

export interface EventDetail extends EventSummary {
  sections: SectionInfo[];
}

export interface SeatMap {
  seatCount: number;
  taken: number[];
}

export interface Hold {
  holdId: string;
  eventId: number;
  sectionId: number;
  seats: { seatNo: number; price: number }[];
  total: number;
  expiresAt: string;
}

export interface Booking {
  total: number;
  tickets: { ticketNo: string; seatNo: number; price: number }[];
  replayed: boolean;
}

export interface Ticket {
  ticket_no: string;
  title?: string;
  section: string;
  seat_no: number;
  price: number;
  start_time?: string;
  venue?: string;
  username?: string;
}

export interface Profile {
  username: string;
  email: string;
  balance: number;
  shard: number;
}

let session: Session | null = JSON.parse(localStorage.getItem("session") ?? "null");

export const getSession = () => session;

export function setSession(next: Session | null) {
  session = next;
  if (next) localStorage.setItem("session", JSON.stringify(next));
  else localStorage.removeItem("session");
}

/** Last coordinator that answered (shown in the header to make load balancing visible). */
export let lastServedBy = "";

export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (session) headers.authorization = `Bearer ${session.token}`;

  const res = await fetch(`/api${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  lastServedBy = res.headers.get("x-served-by") ?? lastServedBy;

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText);
  return data as T;
}

export const pkr = (amount: number) => "PKR " + Math.round(amount).toLocaleString("en-PK");

export const formatDate = (iso: string) =>
  new Date(iso).toLocaleString("en-PK", { dateStyle: "medium", timeStyle: "short" });

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
