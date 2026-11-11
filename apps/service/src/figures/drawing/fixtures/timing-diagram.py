import schemdraw
from schemdraw import logic
with schemdraw.Drawing(show=False) as d:
    logic.TimingDiagram({
        'signal': [
            {'name': 'CLK', 'wave': 'p.......'},
            {'name': 'D', 'wave': '0.1..0.1'},
            {'name': 'Q', 'wave': '0..1..0.'},
        ],
        'config': {'hscale': 1},
    })
