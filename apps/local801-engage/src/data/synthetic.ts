export const syntheticMetrics = {
  represented: 912,
  members: 641,
  nonmembers: 271,
  membershipPercentage: "70.3%",
  newHiresThisMonth: 18,
  additionsThisMonth: 11,
  dropsThisMonth: 4,
  netChange: 7,
  openAssignments: 126,
  overdueFollowups: 14,
  importsInReview: 2,
  activeCampaigns: 3,
  activeCatActions: 1,
  reportingDate: "2026-08-06",
  sourceSnapshot: "Synthetic August snapshot",
  refreshDate: "2026-08-06 09:00",
};

export const syntheticAssignments = [
  {
    person: "Avery Morgan",
    department: "Health Licensing",
    organizer: "Jordan Lee",
    due: "Today",
    channel: "Call",
    status: "Needs first contact",
  },
  {
    person: "Riley Chen",
    department: "Administrative Services",
    organizer: "Morgan Patel",
    due: "Tomorrow",
    channel: "Text",
    status: "Follow-up scheduled",
  },
  {
    person: "Taylor Brooks",
    department: "Environmental Review",
    organizer: "Sam Rivera",
    due: "Friday",
    channel: "Email",
    status: "Awaiting confirmation",
  },
];

export const campaignProgress = [
  { label: "Health Licensing", complete: 78 },
  { label: "Administrative Services", complete: 64 },
  { label: "Environmental Review", complete: 49 },
  { label: "Field Operations", complete: 58 },
];

export const importQueue = [
  {
    name: "Current roster workbook",
    kind: "current_roster",
    state: "Mapping review",
    rows: 912,
    issues: "3 duplicate work emails",
  },
  {
    name: "New-hire CSV",
    kind: "new_hires",
    state: "Validation complete",
    rows: 24,
    issues: "Filtered to Local 0801",
  },
];
