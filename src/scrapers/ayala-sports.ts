// Phase 4 Task 4.8 — Ayala High School athletics (Home Campus).
// Endpoint, robots position and citation rule: see homecampus-sports.ts.
import { homeCampusScraper } from "./homecampus-sports.ts";

export default homeCampusScraper({
	key: "ayala-sports",
	name: "Ayala High School Athletics (scores and schedules)",
	host: "www.ayalasports.com",
	schoolId: 28,
	label: "Ruben S. Ayala High School",
});
