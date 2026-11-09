/** Fixed reference data for the seed: classes, stadiums, the 20-section layout and the fixture list. */

export const TICKET_CLASSES = [
  { classId: 1, name: "Premium", priceMultiplier: 3.0 },
  { classId: 2, name: "General", priceMultiplier: 1.0 },
  { classId: 3, name: "Enclosure", priceMultiplier: 1.8 },
];
const PREMIUM = 1;
const GENERAL = 2;
const ENCLOSURE = 3;

export const VENUES = [
  { venueId: 1, name: "National Bank Stadium", city: "Karachi" },
  { venueId: 2, name: "Gaddafi Stadium", city: "Lahore" },
  { venueId: 3, name: "Rawalpindi Cricket Stadium", city: "Rawalpindi" },
  { venueId: 4, name: "Multan Cricket Stadium", city: "Multan" },
  { venueId: 5, name: "Arbab Niaz Stadium", city: "Peshawar" },
  { venueId: 6, name: "Bugti Stadium", city: "Quetta" },
];

const TEAMS = [
  { name: "Karachi Kings", homeVenueId: 1 },
  { name: "Lahore Qalandars", homeVenueId: 2 },
  { name: "Islamabad United", homeVenueId: 3 },
  { name: "Multan Sultans", homeVenueId: 4 },
  { name: "Peshawar Zalmi", homeVenueId: 5 },
  { name: "Quetta Gladiators", homeVenueId: 6 },
];

/** Every stadium uses this layout: 4 Premium, 6 Enclosure and 10 General sections. */
export function buildSections(seatsPerSection: number) {
  const enclosures = ["Imran Khan", "Wasim Akram", "Javed Miandad", "Hanif Mohammad", "Fazal Mahmood", "Abdul Qadir"];
  return [
    ...["A", "B", "C", "D"].map((letter) => ({ name: `Premium ${letter}`, classId: PREMIUM })),
    ...enclosures.map((legend) => ({ name: `${legend} Enclosure`, classId: ENCLOSURE })),
    ...Array.from({ length: 10 }, (_, i) => ({ name: `General Stand ${i + 1}`, classId: GENERAL })),
  ].map((section, i) => ({ sectionId: i + 1, seatCount: seatsPerSection, ...section }));
}

/** Home-and-away fixtures between every pair of teams, one match a day, repeated per season. */
export function buildEvents(count: number) {
  const pairings = TEAMS.flatMap((home) => TEAMS.filter((away) => away !== home).map((away) => ({ home, away })));
  const firstMatch = new Date();
  firstMatch.setUTCHours(14, 0, 0, 0); // 19:00 Pakistan time
  firstMatch.setUTCDate(firstMatch.getUTCDate() + 7);

  return Array.from({ length: count }, (_, i) => {
    const { home, away } = pairings[i % pairings.length];
    const season = 2027 + Math.floor(i / pairings.length);
    return {
      eventId: i + 1,
      title: `${home.name} vs ${away.name}`,
      tournament: `Pakistan Super League ${season}`,
      homeTeam: home.name,
      awayTeam: away.name,
      venueId: home.homeVenueId,
      startTime: new Date(firstMatch.getTime() + i * 24 * 60 * 60 * 1000).toISOString(),
      basePrice: [1000, 1500, 2000, 2500, 3000][i % 5],
    };
  });
}
