import { randomBytes } from "node:crypto";

/**
 * Ticket numbers encode where the ticket lives:
 *
 *   E017-S05-0123-9F2A  =  event 17, section 5, seat 123, random suffix
 *
 * so a lookup by ticket number is routed straight to the owning shard (Ring A)
 * without asking any other node.
 */

const PATTERN = /^E(\d+)-S(\d+)-(\d+)-[0-9A-F]{4}$/;

export function makeTicketNo(eventId: number, sectionId: number, seatNo: number): string {
  const pad = (n: number, width: number) => String(n).padStart(width, "0");
  const suffix = randomBytes(2).toString("hex").toUpperCase();
  return `E${pad(eventId, 3)}-S${pad(sectionId, 2)}-${pad(seatNo, 4)}-${suffix}`;
}

export function parseTicketNo(ticketNo: string): { eventId: number; sectionId: number; seatNo: number } | null {
  const match = PATTERN.exec(ticketNo.toUpperCase());
  if (!match) return null;
  return { eventId: Number(match[1]), sectionId: Number(match[2]), seatNo: Number(match[3]) };
}
