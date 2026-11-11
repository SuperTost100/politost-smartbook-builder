# schemdraw 0.23 (Python 3, offline; for logic networks, timing diagrams and Karnaugh maps)

The source is Python with no other package (no numpy, no matplotlib). It creates the drawing with `with schemdraw.Drawing(show=False) as d:` and draws into it. The builder selects the SVG backend, the text size and the line weight, so do not call `schemdraw.use`, `d.save()`, `d.draw()` or `print`.
Start with `import schemdraw`, `import schemdraw.elements as elm` and `from schemdraw import logic`.
Labels are plain text. Math goes in `$...$` with braces for a long subscript (`'$V_{out}$'`); a bare underscore prints literally. Words in the book's language are fine.

## Placing elements
Each element starts where the previous one ended and goes in a direction: `.right() .left() .up() .down()`, with a length in units (`.right(2)`). `.at((x, y))` or `.at(element.anchor)` sets the start, `.to((x, y))` the end, `.dot()` puts a dot at the end, `.label('A', 'left')` places a label (`'top' 'bottom' 'left' 'right'`). Keep an element in a variable (`g = logic.And()`) to use its anchors. `elm.Wire('|-').at(p).to(q)` goes vertically and then horizontally, `'-|'` the other way. Anchor points are `(x, y)` pairs, so `g.in1[1]` is the y of an input.

## Logic
`logic.And Or Nand Nor Xor Xnor Not Buf` (`inputs=3` for three inputs) have the anchors `in1 in2 out`. Put gates at explicit coordinates, label an input with `logic.Line().at(...).to(g.in1).label('A', 'left')`, and put a `logic.Dot()` where two wires join. A crossing without a dot is no connection. Half adder, where A and B branch to both gates:
```python
import schemdraw
import schemdraw.elements as elm
from schemdraw import logic
with schemdraw.Drawing(show=False) as d:
    xor = logic.Xor().at((6, 0))
    an = logic.And().at((6, -3))
    logic.Line().at((0, xor.in1[1])).to(xor.in1).label('A', 'left')
    logic.Line().at((0, xor.in2[1])).to(xor.in2).label('B', 'left')
    elm.Wire('|-').at((1, xor.in1[1])).to(an.in1)
    elm.Wire('|-').at((2, xor.in2[1])).to(an.in2)
    logic.Dot().at((1, xor.in1[1]))
    logic.Dot().at((2, xor.in2[1]))
    logic.Line().right(1).at(xor.out).label('S', 'right')
    logic.Line().right(1).at(an.out).label('C', 'right')
```

## Timing diagram
`logic.TimingDiagram({...})` goes straight into the Drawing. One character is one clock period of the signal: `p` clock with a rising edge at the start of the period, `n` falling clock, `0` `1` levels, `.` repeats the previous, `x` unknown, `z` high impedance, `=` a data bus (with `'data': ['a', 'b']`). A trace changes exactly at the start of its characters, which is where a clock rises, so a signal that must change between two edges gets `'phase': 0.5`. A D flip-flop takes D at the next rising edge, so Q has D's string without the phase:
```python
import schemdraw
from schemdraw import logic
with schemdraw.Drawing(show=False) as d:
    logic.TimingDiagram({
        'signal': [
            {'name': 'CLK', 'wave': 'p......'},
            {'name': 'D', 'wave': '0.1..0.', 'phase': 0.5},
            {'name': 'Q', 'wave': '0.1..0.'},
        ],
        'config': {'hscale': 1},
    })
```

## Karnaugh map
`logic.Kmap(names='ABCD', truthtable=[('0000', '1'), ...], groups={'0.0.': {'color': 'red'}}, default='0')` takes two to four names. Rows are the last two names and columns the first two, in Gray order. A truth table row is the input bits as a string and the output; a cell not listed shows `default`. A group key has one character per name: `'0'` or `'1'` for a variable that has that value, `'.'` for one that does not matter. A group must cover 1, 2, 4, 8 or 16 cells in a rectangle (wrap-around is handled). F is 1 for the minterms 0, 1, 4, 5, 10, 11, 14, 15 (ABCD read as a binary number), so the groups are A'C' and AC:
```python
import schemdraw
from schemdraw import logic
with schemdraw.Drawing(show=False) as d:
    logic.Kmap(
        names='ABCD',
        truthtable=[(f'{m:04b}', '1') for m in (0, 1, 4, 5, 10, 11, 14, 15)],
        groups={'0.0.': {'color': 'red'}, '1.1.': {'color': 'blue'}},
        default='0',
    )
```
