import pytest

from app import profiles


def test_stairs_block_wheelchairs_but_not_blind_people():
    assert profiles.effect("escalier", "manuel") == "bloquant"
    assert profiles.effect("escalier", "malvoyant") == "sans_effet"
    assert profiles.effect("escalier", "poussette") == "genant"


def test_long_walk_for_a_walker_warns_from_500_m_and_blocks_beyond_1_km():
    assert profiles.effect("long_trajet_pied", "deambulateur", walk_m=450) == "sans_effet"
    # Gare de Lyon -> Hôpital Necker, tested on Oct 22: 863 m was "Too far to go on foot"
    assert profiles.effect("long_trajet_pied", "deambulateur", walk_m=863) == "genant"
    assert profiles.effect("long_trajet_pied", "deambulateur", walk_m=1200) == "bloquant"


def test_short_roll_is_not_worth_a_warning():
    assert profiles.effect("long_trajet_pied", "manuel", walk_m=479) == "sans_effet"
    assert profiles.effect("long_trajet_pied", "manuel", walk_m=900) == "genant"


def test_warning_threshold_is_below_the_blocking_one():
    for p, warn in profiles.LONG_WALK_WARN_M.items():
        assert warn < profiles.LONG_WALK_BLOCKING_M[p]


def test_walk_word_per_profile():
    assert profiles.walk_word("manuel") == "roll" and profiles.walk_word("electrique") == "roll"
    assert profiles.walk_word("poussette") == "walk" and profiles.walk_word("deambulateur") == "walk"


def test_unknown_profile_falls_back_to_manual_wheelchair():
    assert profiles.normalize("chat") == "manuel"


def test_unknown_obstacle_is_rejected():
    with pytest.raises(ValueError):
        profiles.effect("lave", "manuel")


def test_every_obstacle_covers_every_profile():
    for obstacle, row in profiles.MATRIX.items():
        assert set(row) == set(profiles.PROFILES), obstacle


def test_very_long_roll_blocks_a_manual_wheelchair():
    assert profiles.effect("long_trajet_pied", "manuel", walk_m=1200) == "genant"
    assert profiles.effect("long_trajet_pied", "manuel", walk_m=6000) == "bloquant"
    assert profiles.effect("long_trajet_pied", "valide", walk_m=6000) == "sans_effet"
