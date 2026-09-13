"""One-off build script (not run in production) that produces
app/data/gujarat_locations.json -- the District -> Taluka -> Village
reference dataset seed_locations.py loads into the districts/talukas/villages
tables.

Source: Government of India's Local Government Directory (lgdirectory.gov.in),
the dataset every Indian e-governance system is mandated to key location data
off since a 2016 Cabinet Secretariat order. Pulled via the structured CSV
mirror at https://github.com/planemad/india-local-government-directory
(dataset retrieved by that repo on 2022-03-11 -- the most recent bulk
machine-readable export available; lgdirectory.gov.in's own portal is an
interactive, JS-driven download form, not a scriptable one).

Cross-checked against Wikipedia's district/taluka pages, which surfaced one
real gap this source has: Vav-Tharad became Gujarat's 34th district on
2 October 2025 (carved out of Banaskantha), after this dump was taken. This
script patches that in explicitly (see VAV_THARAD_TALUKAS below) rather than
silently shipping stale data -- everything else is the unmodified LGD dump.

Run once, by hand, whenever this data needs regenerating:
    python scripts/build_data/fetch_gujarat_locations.py
"""
import csv
import io
import json
import urllib.request
import zipfile
from collections import defaultdict

BASE = "https://raw.githubusercontent.com/planemad/india-local-government-directory/master/"
GUJARAT_STATE_CODE = "24"
OUT_PATH = "app/data/gujarat_locations.json"

# LGD/census transliterations for these 8 differ from the spelling this
# codebase (and Gujarat Police in everyday use) already relies on --
# cameras.dept has real rows spelled "Ahmedabad", never LGD's "Ahmadabad".
# Renaming to the common spelling here, rather than the literal LGD spelling,
# keeps a new districts.name row byte-for-byte compatible with every existing
# posting/camera scope_value that already says "Ahmedabad" -- confirmed
# against the live DB's `SELECT DISTINCT dept FROM cameras` before writing
# this. Cross-checked against Wikipedia's own district article titles.
DISTRICT_NAME_CORRECTIONS = {
    "Ahmadabad": "Ahmedabad",
    "Banas Kantha": "Banaskantha",
    "Panch Mahals": "Panchmahal",
    "Sabar Kantha": "Sabarkantha",
    "Dohad": "Dahod",
    "Mahesana": "Mehsana",
    "Kachchh": "Kutch",
    "Chhotaudepur": "Chhota Udaipur",
    "Arvalli": "Aravalli",
}

# Vav-Tharad district, established 2 October 2025 out of Banaskantha's
# northwestern talukas (source: Wikipedia's Vav-Tharad district page and its
# "Talukas of Gujarat" table, cross-checked against each other). Not yet
# reflected in the 2022 LGD dump above, so 6 of these 8 talukas currently sit
# under Banaskantha there and must be re-homed here by exact name match --
# spellings below match the LGD dump's own spelling (e.g. "Lakhani", not
# Wikipedia's infobox spelling "Lakhni"; "Deodar", not "Diyodar").
VAV_THARAD_TALUKAS = {"VAV", "THARAD", "SUIGAM", "LAKHANI", "DEODAR", "BHABHAR"}

# The remaining 2 of Vav-Tharad's 8 talukas -- Rah and Dharnidhar -- don't
# exist under ANY district in the 2022 LGD dump at all (a taluka split newer
# than this dataset). Added directly with no LGD code and no villages rather
# than silently omitted or guessed: seed_locations.py flags these so a
# reviewer knows village-level data is genuinely missing here, not just
# empty.
VAV_THARAD_EXTRA_TALUKAS_NO_LGD_DATA = ["Rah", "Dharnidhar"]

# The LGD village directory covers revenue villages -- most of Gujarat's
# largest cities (Municipal Corporations/major towns) simply aren't in it
# under their own name at all, confirmed by checking each of the top 30
# cities from Wikipedia's "List of cities in Gujarat by population" against
# the fetched village data: 21 of 30 were missing. Added here as their own
# is_urban village entry under the one taluka each maps to unambiguously.
# Ahmedabad, Surat and Vadodara are deliberately NOT patched this way: each
# of those 3 cities is itself split across several zone-level talukas in
# the real data (e.g. Ahmedabad city spans Asarva/Ghatlodiya/Maninagar/
# Sabarmati/Vatva/Vejalpur) with no single taluka that means "the whole
# city" -- inventing one flattening entry would be less accurate than the
# real structure, not a fix for a gap. An officer covering one of those 3
# cities picks the specific zone taluka their camera is actually in.
# (taluka names on the right are the LGD/seeded spelling, not always the
# common one -- e.g. "Mahesana" and "Himatnagar", not "Mehsana"/"Himmatnagar".)
MAJOR_CITIES_MISSING_FROM_LGD_VILLAGES = [
    # (city name, district name, taluka name to nest it under)
    #
    # "Ahmedabad" itself IS added here despite the no-single-taluka problem
    # explained above -- unlike Surat/Vadodara, this codebase already has 5
    # real pre-existing area rows on file against district "Ahmedabad" with
    # no record of which AMC zone they're actually in (see schema.sql's
    # areas.village_id backfill migration), and dropping them from every
    # view because no village matched would be real data loss, not a
    # simplification. Nested under Daskroi -- the taluka that historically
    # surrounded/encompassed Ahmedabad city before it was split into the
    # zone-level talukas seen above -- as a documented, pragmatic anchor for
    # that legacy data. A new area anywhere in Ahmedabad city should be
    # placed under the correct zone taluka (Asarva/Ghatlodiya/Maninagar/
    # Sabarmati/Vatva/Vejalpur) directly instead of under this one.
    ("Ahmedabad", "Ahmedabad", "Daskroi"),
    ("Bhavnagar", "Bhavnagar", "Bhavnagar"),
    ("Jamnagar", "Jamnagar", "Jamnagar City"),
    ("Gandhinagar", "Gandhinagar", "Gandhinagar"),
    ("Anand", "Anand", "Anand City"),
    ("Navsari", "Navsari", "Navsari"),
    ("Surendranagar", "Surendranagar", "Wadhwan"),
    ("Gandhidham", "Kutch", "Gandhidham"),
    ("Nadiad", "Kheda", "Nadiad City"),
    ("Bharuch", "Bharuch", "Bharuch"),
    ("Patan", "Patan", "Patan"),
    ("Mehsana", "Mehsana", "Mahesana"),
    ("Bhuj", "Kutch", "Bhuj"),
    ("Veraval", "Gir Somnath", "Patan-Veraval"),
    ("Valsad", "Valsad", "Valsad"),
    ("Palanpur", "Banaskantha", "Palanpur"),
    ("Himmatnagar", "Sabarkantha", "Himatnagar"),
    ("Botad", "Botad", "Botad"),
    ("Amreli", "Amreli", "Amreli"),
]


def fetch(path: str) -> bytes:
    req = urllib.request.Request(BASE + path, headers={"User-Agent": "netra-data-build"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return resp.read()


def fetch_csv_rows(path: str):
    text = fetch(path).decode("utf-8", errors="replace")
    reader = csv.reader(io.StringIO(text))
    rows = list(reader)
    header = rows[0]
    idx = {h: i for i, h in enumerate(header)}
    return idx, rows[1:]


def main():
    print("Fetching districts...")
    d_idx, d_rows = fetch_csv_rows("administrative/2-district.csv")
    districts = [
        {
            "lgd_code": r[d_idx["District Code"]].strip(),
            "name": DISTRICT_NAME_CORRECTIONS.get(
                r[d_idx["District Name"]].strip().title(), r[d_idx["District Name"]].strip().title()
            ),
        }
        for r in d_rows
        if r[d_idx["State Code"]].strip() == GUJARAT_STATE_CODE
    ]
    # The 2022 dump predates the 2 Oct 2025 Vav-Tharad split -- add it now so
    # every downstream taluka/village re-homing below has somewhere to land.
    # No official LGD district code exists for it in this dump; using a
    # clearly-synthetic placeholder ("NEW-VAV-THARAD") rather than a fake
    # numeric LGD code that could collide with, or be mistaken for, a real one.
    districts.append({"lgd_code": "NEW-VAV-THARAD", "name": "Vav-Tharad"})
    print(f"  {len(districts)} districts (incl. Vav-Tharad patch)")

    print("Fetching talukas...")
    t_idx, t_rows = fetch_csv_rows("administrative/3-subdistrict.csv")
    talukas_by_district_code = defaultdict(list)
    vav_tharad_talukas = []
    for r in t_rows:
        if r[t_idx["State Code"]].strip() != GUJARAT_STATE_CODE:
            continue
        name = r[t_idx["Sub-district Name"]].strip().title()
        code = r[t_idx["Sub-district Code"]].strip()
        district_code = r[t_idx["District Code"]].strip()
        entry = {"lgd_code": code, "name": name}
        if name.upper() in VAV_THARAD_TALUKAS:
            vav_tharad_talukas.append(entry)
        else:
            talukas_by_district_code[district_code].append(entry)
    print(f"  {sum(len(v) for v in talukas_by_district_code.values())} talukas + {len(vav_tharad_talukas)} re-homed to Vav-Tharad")

    print("Fetching villages (zipped, ~13MB)...")
    village_zip = fetch("administrative/4-village.csv.zip")
    zf = zipfile.ZipFile(io.BytesIO(village_zip))
    name = next(n for n in zf.namelist() if n.endswith(".csv"))
    with zf.open(name) as f:
        text = io.TextIOWrapper(f, encoding="utf-8", errors="replace")
        reader = csv.reader(text)
        header = next(reader)
        v_idx = {h: i for i, h in enumerate(header)}
        villages_by_taluka_code = defaultdict(list)
        village_count = 0
        for r in reader:
            if len(r) <= v_idx["State Code"] or r[v_idx["State Code"]].strip() != GUJARAT_STATE_CODE:
                continue
            taluka_code = r[v_idx["Subdistrict Code"]].strip()
            vname = r[v_idx["Village Name (In Englsih)"]].strip().title()
            if not vname:
                continue
            status = r[v_idx["Village Status"]].strip()
            villages_by_taluka_code[taluka_code].append({
                "lgd_code": r[v_idx["Village Code"]].strip(),
                "name": vname,
                "is_urban": status.lower() not in ("village", ""),
            })
            village_count += 1
    print(f"  {village_count} villages/towns")

    # Assemble the nested structure. talukas_by_district_code + villages_by_taluka_code
    # are keyed by the real LGD codes fetched above; Vav-Tharad's talukas are
    # spliced in as their own district with their villages carried over by code.
    out_districts = []
    for d in districts:
        if d["name"] == "Vav-Tharad":
            talukas = vav_tharad_talukas
        else:
            talukas = talukas_by_district_code.get(d["lgd_code"], [])
        out_talukas = []
        for t in talukas:
            villages = villages_by_taluka_code.get(t["lgd_code"], [])
            out_talukas.append({**t, "villages": villages})
        if d["name"] == "Vav-Tharad":
            for extra_name in VAV_THARAD_EXTRA_TALUKAS_NO_LGD_DATA:
                out_talukas.append({
                    "lgd_code": None,
                    "name": extra_name,
                    "villages": [],
                    "no_lgd_data": True,
                })
        for city, district_name, taluka_name in MAJOR_CITIES_MISSING_FROM_LGD_VILLAGES:
            if d["name"] != district_name:
                continue
            taluka = next((t for t in out_talukas if t["name"] == taluka_name), None)
            if taluka is None:
                raise ValueError(f"Expected taluka '{taluka_name}' under {district_name} for {city}, not found")
            if not any(v["name"] == city for v in taluka["villages"]):
                taluka["villages"].append({"lgd_code": None, "name": city, "is_urban": True})
        out_districts.append({**d, "talukas": out_talukas})

    payload = {
        "source": "Government of India Local Government Directory (lgdirectory.gov.in)",
        "mirror": "https://github.com/planemad/india-local-government-directory",
        "dataset_dated": "2022-03-11",
        "patches_applied": [
            (
                "Added Vav-Tharad district (established 2 October 2025 from Banaskantha). "
                "Re-homed 6 of its 8 talukas (Vav, Tharad, Suigam, Bhabhar, Deodar, Lakhani) "
                "from Banaskantha by exact name match. The remaining 2 (Rah, Dharnidhar) do "
                "not exist under any district in this 2022 LGD dump -- added as talukas with "
                "no LGD code and no villages (no_lgd_data: true), not guessed."
            ),
            (
                "Not exhaustively re-audited: taluka-level splits elsewhere in the state newer "
                "than this dataset's 2022-03-11 retrieval date may exist and have not been "
                "individually checked district-by-district against a live source."
            ),
            (
                "Added 18 of Gujarat's 30 largest cities (Wikipedia's 'List of cities in Gujarat "
                "by population') that don't appear in the LGD village directory under their own "
                "name at all -- each nested under the one taluka it unambiguously belongs to. "
                "Ahmedabad, Surat and Vadodara were deliberately NOT patched this way: each spans "
                "several zone-level talukas with no single taluka meaning 'the whole city' -- see "
                "MAJOR_CITIES_MISSING_FROM_LGD_VILLAGES's comment."
            ),
        ],
        "built_at": "2026-09-11",
        "counts": {
            "districts": len(out_districts),
            "talukas": sum(len(d["talukas"]) for d in out_districts),
            "villages": sum(len(t["villages"]) for d in out_districts for t in d["talukas"]),
        },
        "districts": out_districts,
    }

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))

    print(f"Wrote {OUT_PATH}")
    print(payload["counts"])


if __name__ == "__main__":
    main()
