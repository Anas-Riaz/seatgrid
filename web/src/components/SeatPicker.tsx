import { useEffect, useState } from "react";
import { api, errorMessage, pkr, type SeatMap, type SectionInfo } from "../api";

const MAX_SEATS = 6;

interface Props {
  eventId: number;
  section: SectionInfo;
  onHold: (choice: { seatNos?: number[]; quantity?: number }) => void;
}

/** Live seat map (from the Redis bitmap): pick seats yourself, or ask for the best available N. */
export function SeatPicker({ eventId, section, onHold }: Props) {
  const [seatMap, setSeatMap] = useState<SeatMap | null>(null);
  const [chosen, setChosen] = useState<number[]>([]);
  const [quantity, setQuantity] = useState(2);
  const [error, setError] = useState("");

  useEffect(() => {
    api<SeatMap>(`/events/${eventId}/sections/${section.sectionId}/seats`)
      .then(setSeatMap)
      .catch((err) => setError(errorMessage(err)));
  }, [eventId, section.sectionId]);

  if (error) return <p className="error">{error}</p>;
  if (!seatMap) return <p className="muted">Loading seat map…</p>;

  const taken = new Set(seatMap.taken);
  const toggle = (seat: number) =>
    setChosen((current) =>
      current.includes(seat) ? current.filter((s) => s !== seat) : current.length < MAX_SEATS ? [...current, seat] : current,
    );

  return (
    <div>
      <h3>
        {section.name} · {section.price !== null && pkr(section.price)} per seat
      </h3>

      <div className="seat-grid">
        {Array.from({ length: seatMap.seatCount }, (_, i) => i + 1).map((seat) => (
          <button
            key={seat}
            title={`Seat ${seat}`}
            disabled={taken.has(seat)}
            className={`seat ${chosen.includes(seat) ? "chosen" : ""}`}
            onClick={() => toggle(seat)}
          />
        ))}
      </div>

      <div className="controls">
        <button disabled={chosen.length === 0} onClick={() => onHold({ seatNos: chosen })}>
          Hold {chosen.length ? `seats ${chosen.join(", ")}` : "selected seats"}
        </button>
        <span className="muted">or</span>
        <select value={quantity} onChange={(e) => setQuantity(Number(e.target.value))}>
          {Array.from({ length: MAX_SEATS }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <button onClick={() => onHold({ quantity })}>Best available</button>
      </div>
    </div>
  );
}
