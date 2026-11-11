| | |
|---|---|
| **Corso** | Elettrotecnica (ING-IND/31) |
| **Corso di Laurea** | Ingegneria Elettronica, primo anno |
| **Prova** | Prova scritta, Appello del 12 febbraio 2024 |
| **Durata** | 90 minuti, calcolatrice consentita, nessun appunto |
| **Nome e cognome** | ______________________________ |
| **Matricola** | ______________ |

**Problema 1** (12 punti)

Un generatore di tensione continua $V_0 = 12\ \text{V}$ è collegato, tramite un interruttore, a un resistore $R = 4{,}7\ \text{k}\Omega$ in serie a un condensatore $C = 22\ \text{nF}$. Il condensatore è scarico e l'interruttore si chiude all'istante $t = 0$.

a) Calcolare la costante di tempo $\tau$ del circuito.

b) Calcolare la tensione $v_C$ sul condensatore all'istante $t = 100\ \mu\text{s}$.

c) Calcolare dopo quanto tempo la tensione sul condensatore raggiunge il $90\,\%$ di $V_0$.

**Problema 2** (12 punti)

Un filtro passa-basso RC del primo ordine ha $R = 1\ \text{k}\Omega$ e $C = 47\ \text{nF}$ e ha l'uscita ai capi del condensatore.

a) Calcolare la frequenza di taglio $f_c$ del filtro.

b) Calcolare il modulo della funzione di trasferimento, in dB, alla frequenza $f = 10\ \text{kHz}$.

c) Calcolare la fase della funzione di trasferimento alla frequenza di taglio.

**Soluzioni (Appello del 12 febbraio 2024)**

*Problema 1.*

a) $\tau = RC = 4{,}7\ \text{k}\Omega \cdot 22\ \text{nF} = 103{,}4\ \mu\text{s}$.

b) $v_C(100\ \mu\text{s}) = 12\,(1 - e^{-100/103{,}4})\ \text{V} = 7{,}44\ \text{V}$.

c) $t_{90} = \tau \ln 10 = 238{,}1\ \mu\text{s}$.

*Problema 2.*

a) $f_c = \dfrac{1}{RC} = \dfrac{1}{1\ \text{k}\Omega \cdot 47\ \text{nF}} = 21{,}28\ \text{kHz}$.

b) $|H|_{dB} = -10 \log_{10}\!\left[1 + (10/3{,}386)^2\right] = -9{,}88\ \text{dB}$.

c) $\arg H(j\omega_c) = -45^\circ$.

---

| | |
|---|---|
| **Corso** | Elettrotecnica (ING-IND/31) |
| **Corso di Laurea** | Ingegneria Elettronica, primo anno |
| **Prova** | Prova scritta, Appello del 3 luglio 2024 |
| **Durata** | 90 minuti, calcolatrice consentita, nessun appunto |
| **Nome e cognome** | ______________________________ |
| **Matricola** | ______________ |

**Problema 1** (12 punti)

Un amplificatore invertente con amplificatore operazionale ideale ha $R_1 = 3{,}3\ \text{k}\Omega$ e $R_2 = 33\ \text{k}\Omega$. All'ingresso è applicata la tensione continua $v_{in} = 0{,}25\ \text{V}$. L'amplificatore è alimentato a $\pm 12\ \text{V}$.

a) Calcolare il guadagno $G = v_{out}/v_{in}$.

b) Calcolare la tensione di uscita $v_{out}$.

c) Calcolare il massimo valore di $|v_{in}|$ per cui l'amplificatore resta in zona lineare.

**Problema 2** (12 punti)

Un condensatore $C = 1\ \mu\text{F}$ è carico alla tensione $V_0 = 9\ \text{V}$. All'istante $t = 0$ viene collegato a un resistore $R = 22\ \text{k}\Omega$ e si scarica.

a) Calcolare la costante di tempo $\tau$.

b) Calcolare la tensione sul condensatore all'istante $t = 44\ \text{ms}$.

c) Calcolare l'energia immagazzinata nel condensatore all'istante $t = 0$ e all'istante $t = 44\ \text{ms}$.

**Soluzioni (Appello del 3 luglio 2024)**

*Problema 1.*

a) $G = -R_2/R_1 = -10$.

b) $v_{out} = G\, v_{in} = -2{,}5\ \text{V}$.

c) L'uscita satura a $\pm 12\ \text{V}$, quindi $|v_{in}|_{max} = 12/10 = 1{,}2\ \text{V}$.

*Problema 2.*

a) $\tau = RC = 22\ \text{ms}$.

b) $v_C(44\ \text{ms}) = 9\, e^{-2}\ \text{V} = 1{,}218\ \text{V}$.

c) $E(0) = \tfrac12 C V_0^2 = 40{,}5\ \mu\text{J}$ e $E(44\ \text{ms}) = \tfrac12 C\, v_C^2 = 0{,}742\ \mu\text{J}$.
