export const NC_ZONING_COUNTIES = Object.freeze([
  'Alamance', 'Alexander', 'Alleghany', 'Anson', 'Ashe', 'Avery', 'Beaufort', 'Bertie', 'Bladen', 'Brunswick',
  'Buncombe', 'Burke', 'Cabarrus', 'Caldwell', 'Camden', 'Carteret', 'Caswell', 'Catawba', 'Chatham', 'Cherokee',
  'Chowan', 'Clay', 'Cleveland', 'Columbus', 'Craven', 'Cumberland', 'Currituck', 'Dare', 'Davidson', 'Davie',
  'Duplin', 'Durham', 'Edgecombe', 'Forsyth', 'Franklin', 'Gaston', 'Gates', 'Graham', 'Granville', 'Greene',
  'Guilford', 'Halifax', 'Harnett', 'Haywood', 'Henderson', 'Hertford', 'Hoke', 'Hyde', 'Iredell', 'Jackson',
  'Johnston', 'Jones', 'Lee', 'Lenoir', 'Lincoln', 'Macon', 'Madison', 'Martin', 'McDowell', 'Mecklenburg',
  'Mitchell', 'Montgomery', 'Moore', 'Nash', 'New Hanover', 'Northampton', 'Onslow', 'Orange', 'Pamlico',
  'Pasquotank', 'Pender', 'Perquimans', 'Person', 'Pitt', 'Polk', 'Randolph', 'Richmond', 'Robeson', 'Rockingham',
  'Rowan', 'Rutherford', 'Sampson', 'Scotland', 'Stanly', 'Stokes', 'Surry', 'Swain', 'Transylvania', 'Tyrrell',
  'Union', 'Vance', 'Wake', 'Warren', 'Washington', 'Watauga', 'Wayne', 'Wilkes', 'Wilson', 'Yadkin', 'Yancey',
]);

export function ncZoningCounty(value) {
  const input = String(value || '').replace(/,\s*NC$/i, '').replace(/\s+County$/i, '').trim();
  return NC_ZONING_COUNTIES.find((county) => county.toLowerCase() === input.toLowerCase()) || null;
}
