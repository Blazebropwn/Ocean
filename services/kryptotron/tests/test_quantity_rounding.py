from decimal import Decimal
import pytest
from utils import round_step

@pytest.mark.parametrize('quantity,step,expected', [
    (.00031,.00001,.00031), (.0003,.00001,.0003), (.0002595,.00001,.00025),
    (.0075,.0001,.0075), (.031,.001,.031), (.29,.01,.29), (1.29,.05,1.25),
    (0,.00001,0), (.0000095,.00001,0),
])
def test_decimal_floor_never_drops_a_valid_lot(quantity, step, expected):
    actual = round_step(quantity, step)
    assert actual == expected
    assert Decimal(str(actual)) <= Decimal(str(quantity))
    assert Decimal(str(actual)) % Decimal(str(step)) == 0

@pytest.mark.parametrize('quantity,step', [(float('nan'),.01), (1,0), (-1,.01), (1,float('inf'))])
def test_invalid_order_amount_is_rejected(quantity, step):
    with pytest.raises(ValueError):
        round_step(quantity, step)
