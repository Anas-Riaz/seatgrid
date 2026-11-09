import { useCallback, useEffect, useState } from "react";
import { api, errorMessage, type EventDetail, formatDate, type Hold, pkr, type SectionInfo } from "../api";
import { Checkout } from "./Checkout";
import { SeatPicker } from "./SeatPicker";

interface Props {
  eventId: number;
  signedIn: boolean;
  onBooked: () => void;
}

/** One match: sections with availability, then seat selection and checkout for the chosen section. */
export function EventDetailPanel({ eventId, signedIn, onBooked }: Props) {
  const [event, setEvent] = useState<EventDetail | null>(null);
  const [section, setSection] = useState<SectionInfo | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api<EventDetail>(`/events/${eventId}`)
      .then((detail) => {
        setEvent(detail);
        setError("");
      })
      .catch((err) => setError(errorMessage(err)));
  }, [eventId]);

  useEffect(() => {
    setSection(null);
    load();
  }, [load]);

  if (error) return <section className="panel error">{error}</section>;
  if (!event) return <section className="panel muted">Loading…</section>;

  return (
    <section className="panel">
      <h2>{event.title}</h2>
      <p className="muted">
        {formatDate(event.start_time)} · {event.venue}, {event.city}
      </p>

      <table>
        <thead>
          <tr>
            <th>Section</th>
            <th>Class</th>
            <th>Price</th>
            <th>Free</th>
          </tr>
        </thead>
        <tbody>
          {event.sections.map((s) => (
            <tr
              key={s.sectionId}
              className={s.sectionId === section?.sectionId ? "active clickable" : "clickable"}
              onClick={() => setSection(s)}
            >
              <td>{s.name}</td>
              <td>{s.className}</td>
              <td>{s.price !== null ? pkr(s.price) : "—"}</td>
              <td>
                {s.available} / {s.total}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {section && !signedIn && <p className="muted">Log in to buy tickets.</p>}
      {section && signedIn && (
        <BuyFlow
          key={section.sectionId}
          eventId={eventId}
          section={section}
          onBooked={() => {
            load();
            onBooked();
          }}
        />
      )}
    </section>
  );
}

/** Pick seats -> hold -> pay. Remounted (fresh state) whenever the section changes. */
function BuyFlow({ eventId, section, onBooked }: { eventId: number; section: SectionInfo; onBooked: () => void }) {
  const [hold, setHold] = useState<Hold | null>(null);
  const [error, setError] = useState("");

  async function startHold(choice: { seatNos?: number[]; quantity?: number }) {
    setError("");
    try {
      setHold(await api<Hold>("/holds", { method: "POST", body: { eventId, sectionId: section.sectionId, ...choice } }));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  function finish() {
    setHold(null);
    onBooked();
  }

  return (
    <div className="buy">
      {error && <p className="error">{error}</p>}
      {hold ? (
        <Checkout hold={hold} onDone={finish} />
      ) : (
        <SeatPicker eventId={eventId} section={section} onHold={startHold} />
      )}
    </div>
  );
}
