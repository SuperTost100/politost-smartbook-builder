### Tecniche di calcolo

#### Non esistenza: restrizioni a rette e curve

Se si trovano due restrizioni di $f$ con limiti distinti, il limite complessivo non esiste. Il metodo è questo:

**Errore tipico.** Concludere che il limite esiste e vale $0$ perché "lungo tutte le rette viene $0$". Le rette sono solo uno degli infiniti modi di avvicinarsi al punto: due legami diversi fra $x$ e $y$ possono dare comportamenti diversi, come mostra l'ultimo esempio. Le restrizioni provano la non esistenza, mai l'esistenza. Per provare l'esistenza servono una maggiorazione o le coordinate polari.

#### Esistenza: maggiorazioni e confronto

Per dimostrare che il limite vale $\ell$ si maggiora $|f(x,y)-\ell|$ con una quantità che tende a $0$ e si usa il teorema del doppio confronto (per funzioni a valori scalari). Si usano disuguaglianze come $|x|\le\sqrt{x^2+y^2}$.

**Esempio.** Sia $f(x,y)=\dfrac{|x||y|}{\sqrt{x^2+y^2}}$. Poiché $\dfrac{|x|}{\sqrt{x^2+y^2}}\le1$, si ottiene $0\le|f(x,y)|\le|y|\to0$. Quindi $\lim_{(x,y)\to(0,0)}f(x,y)=0$.

#### Coordinate polari

