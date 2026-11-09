import { useEffect, useState } from "react";
import { api, errorMessage, type EventSummary, formatDate, lastServedBy, pkr } from "../api";

interface SearchResult {
  total: number;
  results: EventSummary[];
}

/** Text search, price filter and sorting over the replicated event catalog. */
export function EventSearch({ selectedId, onSelect }: { selectedId: number | null; onSelect: (id: number) => void }) {
  const [q, setQ] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [sort, setSort] = useState("date");
  const [order, setOrder] = useState("asc");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const timer = setTimeout(async () => {
      const params = new URLSearchParams({ sort, order, limit: "20" });
      if (q.trim()) params.set("q", q.trim());
      if (maxPrice) params.set("maxPrice", maxPrice);
      try {
        setResult(await api<SearchResult>(`/events?${params}`));
        setError("");
      } catch (err) {
        setError(errorMessage(err));
      }
    }, 250); // debounce typing
    return () => clearTimeout(timer);
  }, [q, maxPrice, sort, order]);

  return (
    <section>
      <div className="controls">
        <input placeholder="Search teams, city or stadium (e.g. karachi lahore)" value={q} onChange={(e) => setQ(e.target.value)} />
        <input placeholder="Max price" type="number" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} />
        <select value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="date">Date</option>
          <option value="price">Price</option>
          <option value="availability">Seats left</option>
          <option value="title">Name</option>
        </select>
        <select value={order} onChange={(e) => setOrder(e.target.value)}>
          <option value="asc">Ascending</option>
          <option value="desc">Descending</option>
        </select>
      </div>

      {error && <p className="error">{error}</p>}
      {result && (
        <p className="muted">
          {result.total} matches · served by {lastServedBy}
        </p>
      )}

      <ul className="list">
        {result?.results.map((event) => (
          <li
            key={event.event_id}
            className={event.event_id === selectedId ? "active" : ""}
            onClick={() => onSelect(event.event_id)}
          >
            <strong>{event.title}</strong>
            <span>
              {formatDate(event.start_time)} · {event.venue}, {event.city}
            </span>
            <span>
              {event.available_seats.toLocaleString()} seats left · from {pkr(event.base_price)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
