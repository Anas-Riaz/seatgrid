import { type FormEvent, useState } from "react";
import { api, errorMessage, formatDate, pkr, type Ticket } from "../api";

/** Lookup by ticket number: the number encodes event and section, so it is routed to one shard. */
export function TicketLookup() {
  const [ticketNo, setTicketNo] = useState("");
  const [ticket, setTicket] = useState<(Ticket & { shard: number; city: string }) | null>(null);
  const [error, setError] = useState("");

  async function search(e: FormEvent) {
    e.preventDefault();
    setTicket(null);
    setError("");
    try {
      setTicket(await api(`/tickets/${encodeURIComponent(ticketNo.trim())}`));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <section className="panel narrow">
      <form className="controls" onSubmit={search}>
        <input value={ticketNo} onChange={(e) => setTicketNo(e.target.value)} placeholder="E017-S05-0123-9F2A" />
        <button type="submit">Find</button>
      </form>
      {error && <p className="error">{error}</p>}
      {ticket && (
        <dl>
          <dt>Match</dt>
          <dd>{ticket.title}</dd>
          <dt>When / where</dt>
          <dd>
            {ticket.start_time && formatDate(ticket.start_time)} · {ticket.venue}, {ticket.city}
          </dd>
          <dt>Seat</dt>
          <dd>
            {ticket.section}, seat {ticket.seat_no}
          </dd>
          <dt>Holder</dt>
          <dd>{ticket.username}</dd>
          <dt>Price</dt>
          <dd>{pkr(ticket.price)}</dd>
          <dt>Stored on</dt>
          <dd>shard {ticket.shard}</dd>
        </dl>
      )}
    </section>
  );
}
