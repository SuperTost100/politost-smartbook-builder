
**Metodo.**

1. Verificare che $\mathbf{v}$ sia un versore, cioè $\|\mathbf{v}\|=1$ (si veda [Richiami su vettori e matrici](ref:section/2461bad8-91b5-4d4c-aa58-8693c138879d)). Qui $\frac12+\frac12=1$.
2. Scrivere la definizione, senza usare il gradiente:
$\displaystyle \frac{\partial f}{\partial \mathbf{v}}(\mathbf{0})=\lim_{t\to 0}\frac{f(t\mathbf{v})-f(\mathbf{0})}{t}.$
3. Sostituire il punto $t\mathbf{v}=\left(\frac{\sqrt2}{2}t,\frac{\sqrt2}{2}t\right)$ nell'espressione giusta. Per $t\neq0$ si ha $y\neq 0$, quindi vale il primo ramo, mentre $f(\mathbf{0})=0$ per il secondo ramo.
4. Semplificare. Il rapporto $x/y$ vale $1$ per ogni $t\neq 0$, quindi il rapporto incrementale è costante:
$\displaystyle \frac{\frac{\sqrt2}{2}t\,\sin 1}{t}=\frac{\sqrt2}{2}\sin 1 .$
5. Il limite esiste e vale $\frac{\sqrt2}{2}\sin 1$, quindi si sceglie l'opzione con questo valore. La funzione $t\mapsto f(t\mathbf v)$ coinvolge una sola variabile, quindi basta un limite in $t$, da calcolare per $t\to0^+$ e $t\to0^-$ (qui coincidono).
