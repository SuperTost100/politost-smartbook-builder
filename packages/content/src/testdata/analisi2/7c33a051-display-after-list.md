
**Che cosa chiede l'esame.** Si assegna una funzione scritta con due espressioni, una per $y \neq 0$ e una per $y = 0$, e si chiede la derivata direzionale nell'origine lungo un versore dato. Le quattro risposte comprendono "non esiste" e tre valori espliciti. Nell'**Appello 1, esercizio 4**, la funzione contiene un termine del tipo $y\sin(x/y)$ e il versore è $\mathbf{v}=\left(\frac{\sqrt2}{2},\frac{\sqrt2}{2}\right)$.

**Metodo.**

**Metodo.**

1. Verificare che $\mathbf{v}$ sia un versore, cioè $\|\mathbf{v}\|=1$ (si veda [Richiami su vettori e matrici](ref:section/2461bad8-91b5-4d4c-aa58-8693c138879d)). Qui $\frac12+\frac12=1$.
2. Scrivere la definizione, senza usare il gradiente:

$$
\frac{\partial f}{\partial \mathbf{v}}(\mathbf{0})=\lim_{t\to 0}\frac{f(t\mathbf{v})-f(\mathbf{0})}{t}.
$$

3. Sostituire il punto $t\mathbf{v}=\left(\frac{\sqrt2}{2}t,\frac{\sqrt2}{2}t\right)$ nell'espressione giusta. Per $t\neq0$ si ha $y\neq 0$, quindi vale il primo ramo, mentre $f(\mathbf{0})=0$ per il secondo ramo.
4. Semplificare. Il rapporto $x/y$ vale $1$ per ogni $t\neq 0$, quindi il rapporto incrementale è costante:

$$
\frac{\frac{\sqrt2}{2}t\,\sin 1}{t}=\frac{\sqrt2}{2}\sin 1 .
$$

5. Il limite esiste e vale $\frac{\sqrt2}{2}\sin 1$, quindi si sceglie l'opzione con questo valore. La funzione $t\mapsto f(t\mathbf v)$ coinvolge una sola variabile, quindi basta un limite in $t$, da calcolare per $t\to0^+$ e $t\to0^-$ (qui coincidono).

Le definizioni e il significato di derivata direzionale sono in [Derivate parziali, direzionali e gradiente](ref:section/103f5607-08be-4d93-8c32-b0c122821105). Il legame con i limiti, e in particolare l'uso di restrizioni lungo curve, è in [Limiti e continuità](ref:section/5649feba-063c-4689-a105-74243f24f8b4).

