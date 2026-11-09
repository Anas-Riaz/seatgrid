import { useEffect, useState } from "react";
import { api, errorMessage, formatDate, pkr, type Ticket } from "../api";

/** The user's tickets, read from the user_tickets index on their own shard (Ring B). */
export function MyTickets() {
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<Ticket[]>("/me/tickets")
      .then(setTickets)
      .catch((err) => setError(errorMessage(err)));
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!tickets) return <p className="muted">Loading…</p>;
  if (tickets.length === 0) return <p className="muted">No tickets yet.</p>;

  return (
    <table>
      <thead>
        <tr>
          <th>Ticket</th>
          <th>Match</th>
          <th>Seat</th>
          <th>Price</th>
        </tr>
      </thead>
      <tbody>
        {tickets.map((t) => (
          <tr key={t.ticket_no}>
            <td>
              <code>{t.ticket_no}</code>
            </td>
            <td>
              {t.title}
              <div className="muted">{t.start_time && formatDate(t.start_time)}</div>
            </td>
            <td>
              {t.section}, seat {t.seat_no}
            </td>
            <td>{pkr(t.price)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
