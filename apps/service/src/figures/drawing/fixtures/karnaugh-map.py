import schemdraw
from schemdraw import logic
with schemdraw.Drawing(show=False) as d:
    logic.Kmap(
        names='ABCD',
        truthtable=[('0000', '1'), ('0001', '1'), ('0101', '1'), ('0100', '1'), ('1100', '1'), ('1101', '1'), ('1000', '1'), ('1001', '1'), ('0111', '1'), ('1111', '1')],
        groups={'.0.0': {'color': 'red'}, '.1.1': {'color': 'blue'}},
        default='0',
    )
