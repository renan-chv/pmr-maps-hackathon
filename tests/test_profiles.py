import pytest

from app import profiles


def test_stairs_block_wheelchairs_but_not_blind_people():
    assert profiles.effect("escalier", "manuel") == "bloquant"
    assert profiles.effect("escalier", "malvoyant") == "sans_effet"
    assert profiles.effect("escalier", "poussette") == "genant"


def test_long_walk_blocks_walker_beyond_500_m():
    assert profiles.effect("long_trajet_pied", "deambulateur", walk_m=450) == "genant"
    assert profiles.effect("long_trajet_pied", "deambulateur", walk_m=650) == "bloquant"


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
