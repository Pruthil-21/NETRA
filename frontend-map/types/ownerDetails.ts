// Shapes returned by backend-watchlist's government-database lookups.
// `status` is "not_configured" until real access is set up server-side --
// see backend-watchlist/app/services/govt_lookup_service.py. The other
// fields stay null until then; render around that rather than assuming
// they're populated.
export type GovtLookupStatus = 'not_configured' | 'not_implemented' | 'ok';

// VAHAN (MoRTH vehicle registry) -- ownership/registration, by plate number.
export interface VahanDetails {
  status: GovtLookupStatus;
  plate_number: string;
  owner_name: string | null;
  vehicle_model: string | null;
  registration_date: string | null;
}

// eGujCop (Gujarat Police) -- crime/FIR records linked to a plate number.
export interface EGujCopDetails {
  status: GovtLookupStatus;
  plate_number: string;
  has_open_case: boolean | null;
  case_ids: string[] | null;
}

// GET /vehicle-lookup/{plate} -- combined, since both above are plate-keyed.
export interface VehicleGovtLookup {
  vahan: VahanDetails;
  egujcop: EGujCopDetails;
}

// SARTHI (MoRTH driving license registry) -- holder details, by DL number.
// Keyed separately from the above: ml-anpr only ever captures plate reads,
// never a DL number, so this is never attached to a plate/alert.
export interface SarathiDetails {
  status: GovtLookupStatus;
  dl_number: string;
  holder_name: string | null;
  license_class: string | null;
  issue_date: string | null;
}
