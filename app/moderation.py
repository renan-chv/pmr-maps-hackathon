"""Small filter for community report descriptions (App Store guideline 1.2: user-generated content).

Catches obvious slurs and obscenities in French and English, including simple disguises (accents, capitals,
"f*ck", digits for letters as in "s4lope"). Spaced-out letters are not caught: the flag button covers the rest.
Whole words only, so place names and normal words that contain the same letters ("Scunthorpe", "technique",
"salopette") are never refused.
Words that describe a real obstacle stay allowed (e.g. "merde"/"shit": dog mess on the sidewalk), and so does
the French "retard" (delay).
"""
from __future__ import annotations

import re
import unicodedata

# Exact words (after normalisation: lowercase, no accents). Left out on purpose because they have an innocent
# meaning in a street report: "retard(s)" (French: delay), "chink" (gap), "fag" (UK: cigarette), "cripple",
# "spastic" (medical, and words disabled people use about themselves), "con" (too many false positives).
_WORDS = {
    # English: obscenities and insults
    "cunt", "cunts", "bitch", "bitches", "bastard", "bastards", "asshole", "assholes", "arsehole", "dickhead",
    "whore", "whores", "slut", "sluts", "twat", "twats", "wanker", "wankers", "bollocks", "cocksucker",
    # English: slurs
    "nigga", "niggas", "faggot", "faggots", "kike", "kikes", "spic", "spics",
    "wetback", "tranny", "trannies", "retarded", "spaz",
    # French: obscenities and insults
    "connard", "connards", "connasse", "connasses", "conasse", "salope", "salopes", "salopard", "salopards",
    "salaud", "salauds", "pute", "putes", "putain", "putains", "batard", "batards", "fdp", "ntm",
    "branleur", "branleurs", "branleuse", "pouffiasse", "petasse", "couilles",
    # French: slurs
    "pede", "pedes", "gouine", "gouines", "negre", "negres", "negro", "negros", "bougnoule", "bougnoules",
    "bicot", "bicots", "youpin", "youpins", "youtre", "chinetoque", "chinetoques", "bamboula", "gogol", "gogols",
    "mongolien", "mongoliens", "triso", "trisos",
}
# Word starts that are never innocent: "enculé(s)", "enculer", "niquer", "nique ta…".
_PREFIXES = ("encul", "niqu", "fuck", "nigger", "motherf")
# Letters inside a longer token: "motherfucker", "clusterfuck".
_INSIDE = ("fuck", "nigger")
_LEET = str.maketrans({"0": "o", "1": "i", "3": "e", "4": "a", "@": "a", "$": "s", "5": "s", "7": "t"})


def _tokens(text: str) -> list:
    s = unicodedata.normalize("NFKD", text or "")
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    # leetspeak only inside words: "s4lope" -> "salope", but "4 steps" keeps its number
    words = re.findall(r"[a-z0-9@$*]+", s)
    out = []
    for w in words:
        if re.search(r"[a-z]", w):
            w = w.translate(_LEET).replace("*", "u")  # "f*ck" -> "fuck"
        out.append(w)
    return out


def is_offensive(text: str) -> bool:
    for w in _tokens(text):
        if w in _WORDS or w.startswith(_PREFIXES) or any(bad in w for bad in _INSIDE):
            return True
    return False


OFFENSIVE_DETAIL = ("Votre description contient des mots que nous ne pouvons pas publier. "
                    "Décrivez l'obstacle sans ces mots, puis renvoyez-le.")
