# Adaptateur Babylon 9.29.x

L'intégration fournit les chemins temporel, spatial et bilinéaire via FrameGraphUpscaleTask. Elle est testée avec @babylonjs/core@9.29.0. Les accès internes nécessaires sont regroupés dans src/babylon/compatibility.ts et protégés par une vérification de version et de disponibilité du moteur WebGPU.

Construire la tâche avec un nom, le FrameGraph et des options contenant configuration, callback frame et réglages facultatifs. `configuration.path` vaut `temporal` par défaut ; `spatial` active EASU + RCAS, et `bilinear` active le redimensionnement bilinéaire. Le type exporté `FrameGraphUpscaleConfiguration` décrit ces configurations. Le mode `guides` du cœur n'est pas exposé par cette tâche.

Assigner `colorTexture` dans tous les cas, et `depthTexture` / `velocityTexture` pour le chemin temporel. Les chemins spatial et bilinéaire fonctionnent avec la couleur seule et n'ajoutent aucun jitter. Les entrées facultatives restent `reactiveTexture`, `reactiveOpaqueColorTexture`, `exposureTexture` et `preExposureTexture`. Ajouter la tâche au graphe avant le consommateur de `outputTexture`. Attendre `graph.buildAsync()` avant la première exécution.

Les entrées doivent être rendues sous le même jitter que celui publié par upscale.jitter. beginFrame(camera) sauvegarde la projection existante, y compose le jitter et la fige. endFrame() restaure aussi son état de gel initial. Encadrer le rendu des entrées et l'exécution du graphe dans un try/finally ; en cas d'abandon, demander resetHistory(). unjitteredProjectionMatrix fournit la projection pour le calcul des mouvements.

L'hôte conserve la responsabilité de rendre la scène, d'écrire les mouvements, de linéariser la profondeur et de produire l'exposition. Les tâches en amont s'exécutent avant l'upscaler. [L'exemple complet](https://github.com/bpodwinski/upscaler/blob/main/examples/18-babylon-framegraph/main.ts) montre ces contrats avec une scène analytique HDR, sans masquer leur production derrière un pipeline de scène.

La tâche alloue toutes ses textures via le texture manager. Chaque historique a un seul handle ; getTextureFromHandle(handle, false/true) résout sa lecture/écriture. Aucune permutation supplémentaire n'est effectuée. Le traitement est enregistré dans une passe de rendu, car l'analyse des durées de vie de cette version collecte les dépendances de ces passes. Toutes les entrées et toutes les textures de travail figurent dans ses dépendances, y compris les historiques et textures factices.

Avant les passes compute, le pont ferme la passe de rendu active et récupère l'encodeur du moteur. L'adaptateur ne crée pas de second encodeur et ne soumet pas sur la queue. Le moteur conserve la fin de frame et la soumission.

Une tâche non préparée n'est pas prête à être exécutée ; attendre prepare(), graph.buildAsync() ou whenReadyAsync(). Les pipelines facultatives de debug et shading sont préparées aussi pour permettre les réglages retournés par le callback de frame. disabled = true produit une sortie bilinéaire définie dans le même handle et invalide l'historique temporel. La réactivation force un reset.

Après resize ou changement de variante, appeler configure(), attendre prepare(), puis reconstruire le Frame Graph avec buildAsync(). Les anciens handles intermédiaires appartiennent au texture manager et sont libérés par la reconstruction. Si des textures hôtes sont remplacées, reconstruire leurs dépendances et demander un reset. Après un encodeur abandonné, demander également un reset.

Le namespace avancé babylonWebGPU expose le pont protégé pour les tâches hôtes qui encodent leurs propres compute, comme le générateur analytique de l'exemple. Sa compatibilité reste limitée à la série 9.29.x.

Après perte du device, arrêter l'exécution du graphe. Une fois le moteur restauré,
recréer le graphe, la tâche et les ressources sur le nouveau device, puis attendre
leur préparation. Avec Babylon 9.29.0, l'observable de restauration peut se
déclencher avant la fin de l'initialisation WebGPU : attendre également la promesse
réelle d'initialisation du moteur avant de reconstruire. Les anciens handles et
l'ancien cœur ne sont pas réutilisables. Cette séquence a été vérifiée par perte
contrôlée `GPUDevice.destroy()` sur RX 580 et RTX 5080 ; elle ne couvre pas un crash
du pilote. Les démonstrations avec meshes demandent toujours un rechargement.

La future migration Exokosm devra confirmer : unité et fond de profondeur, signe/espace du mouvement, projections sans jitter, reactive mask, distinction des deux expositions, dimensions dynamiques, position des tâches et présentation HDR. Ce fork ne modifie pas Exokosm.

## Exemples avec des meshes

La galerie comporte douze adaptations des démonstrations Three, construites sur
le même [présentateur Babylon](https://github.com/bpodwinski/upscaler/blob/main/examples/shared/babylon/BabylonScenePresenter.ts) :

| Exemple | Ce qu'il permet d'observer |
| --- | --- |
| [19 — Hello](https://github.com/bpodwinski/upscaler/blob/main/examples/19-babylon-hello/main.ts) | Scène 3D, animation, réglages de résolution, temporel et bilinéaire |
| [20 — Aliasing](https://github.com/bpodwinski/upscaler/blob/main/examples/20-babylon-aliasing/main.ts) | Barreaux sous-pixel, fils croisés, damier géométrique, convergence immobile |
| [21 — Comparaison](https://github.com/bpodwinski/upscaler/blob/main/examples/21-babylon-compare/main.ts) | Référence native sans AA et reconstruction, avec séparateur mobile |
| [22 — Transparence](https://github.com/bpodwinski/upscaler/blob/main/examples/22-babylon-transparency/main.ts) | Sphère alpha-blended et éléments émissifs, masque réactif activable |
| [23 — Spatial / temporel](https://github.com/bpodwinski/upscaler/blob/main/examples/23-babylon-spatial-temporal/main.ts) | Deux rendus basse résolution, EASU + RCAS sans jitter face au temporel jitteré |
| [24 — Composition](https://github.com/bpodwinski/upscaler/blob/main/examples/24-babylon-compose/main.ts) | Vignette dans une tâche du graphe consommant la sortie de l'upscaler |
| [25 — Masque dessiné](https://github.com/bpodwinski/upscaler/blob/main/examples/25-babylon-reactive-mask/main.ts) | Couverture des meshes transparents, occlusion par la profondeur opaque et affichage du masque |
| [26 — Canvas transparent](https://github.com/bpodwinski/upscaler/blob/main/examples/26-babylon-transparent-canvas/main.ts) | Reconstruction de l'alpha des silhouettes et composition sur le contenu HTML |
| [27 — Effets écran](https://github.com/bpodwinski/upscaler/blob/main/examples/27-babylon-screen-effects/main.ts) | SSAO ou SSR Babylon à basse résolution avant reconstruction |
| [28 — Effets combinés](https://github.com/bpodwinski/upscaler/blob/main/examples/28-babylon-effect-stack/main.ts) | SSAO, SSR et bloom HDR activables séparément |
| [29 — Guides temporels](https://github.com/bpodwinski/upscaler/blob/main/examples/29-babylon-temporal-guides/main.ts) | Disocclusion, profondeur dilatée, mouvement dilaté et sortie finale |
| [30 — Guides partagés](https://github.com/bpodwinski/upscaler/blob/main/examples/30-babylon-guides-compose/main.ts) | Coloration des disocclusions entre production des guides et upscale final |

Ces exemples partagent leurs scènes et leur interface dans `examples/shared/babylon`.
Ils adaptent le but des exemples Three ; ils ne reproduisent pas leurs matériaux
TSL. Le sélecteur NativeAA utilise le chemin temporel à la résolution d'affichage.
Les dimensions par défaut sont celles du canvas en pixels CSS.

Les exemples 23, 24, 25 et 26 adaptent respectivement les objectifs des exemples
Three 02, 08, 11 et 15. L'équivalent de la composition TSL est une tâche du Frame
Graph. Le contrôle de reconstruction agit sur la moitié droite de la comparaison
23 ; la moitié gauche conserve son traitement spatial.

Le `FrameGraphGeometryRendererTask` fournit la couleur opaque HDR, la profondeur
en espace vue R32F et `PREPASS_VELOCITY_LINEAR_TEXTURE_TYPE`. Une passe compute
normalise ces entrées avant l'upscaler :

- Les render targets WebGPU Babylon 9.29 sont inversées verticalement. La passe
  retourne ensemble couleur, profondeur, mouvement et entrées du masque, pour
  fournir au cœur des images dont l'origine est en haut à gauche.
- Le mouvement brut vaut `0.5 * (previousNDC - currentNDC)`, jitter compris.
  Après retournement des texels, le mouvement UV fourni au cœur est
  `(-raw.x, raw.y) + (jitterCurrent - jitterPrevious) / renderSize`, avec
  `motionScale = (1, 1)`. La première frame après reset fournit un mouvement nul.
- La profondeur de fond, nulle dans Babylon, devient `camera.maxZ`, positive et
  finie. Les objets conservent leur profondeur linéaire.
- Le masque utilise la différence RGB entre la couleur opaque et le rendu
  complet, avec seuil `0.04`, facteur `2` et plafond `0.9`. Le désactiver écrit zéro
  sans changer les dépendances du graphe. Il s'agit d'une heuristique de démo.

L'exemple 25 remplace cette heuristique par une passe de couverture. Les meshes
transparents sont rendus avec un matériau blanc spécifique à cette passe, sous
le même jitter que la couleur. La passe réutilise la profondeur opaque, avec
test de profondeur actif et écriture désactivée. La couverture blanche vaut `1`.
Le bouton « Show mask » affiche la texture réellement fournie au cœur.

La transparence effectue un rendu complet supplémentaire pour conserver une
référence opaque. La comparaison utilise une seconde caméra avec la projection
sans jitter et un rendu à la résolution d'affichage. La présentation retourne sa
texture native et applique la même transformation Reinhard/gamma des deux côtés.
Ces rendus supplémentaires servent à comparer les images, pas à mesurer les
performances du cœur. L'exposition fournie est constante à `1` ; l'exemple 18
reste celui des variations d'exposition.

La comparaison spatiale effectue elle aussi un second rendu, mais à basse
résolution et sans jitter. Une tâche retourne la couleur vers l'origine en haut
à gauche avant EASU + RCAS. La tâche
[`ColorEffectTask`](https://github.com/bpodwinski/upscaler/blob/main/examples/shared/babylon/ColorEffectTask.ts) sert également
à la composition : sa sortie possède son propre handle, sa dépendance envers
l'entrée est explicite, et la vignette conserve l'alpha sans modifier l'historique
temporel. Avec une force nulle, elle reproduit exactement la couleur d'entrée.

Le canvas transparent utilise un fond RGBA nul dans les cibles de scène. La
présentation dé-prémultiplie la couleur HDR par la couverture avant Reinhard/gamma,
puis la prémultiplie pour le canvas WebGPU configuré en `premultipliedAlpha`.
Le damier, les fonds clair/sombre et le texte sont des éléments HTML/CSS placés
derrière le canvas, pas des textures rendues par Babylon.

Le présentateur reconstruit son graphe lors des changements de taille ou de
ratio, restaure la projection dans un `finally`, et libère ses ressources à la
sortie de la page. Après perte du device, l'interface demande de recharger.
Les points d'entrée utilisent un bootstrap asynchrone sans top-level await pour
permettre le chargement des shaders Babylon dans le build de production.

## Effets écran et guides partagés

Les exemples 27 et 28 utilisent les tâches natives `FrameGraphSSAO2RenderingPipelineTask`,
`FrameGraphSSRRenderingPipelineTask` et `FrameGraphBloomTask`. Les effets traitent le
G-buffer dans son orientation Babylon ; la normalisation des entrées intervient
ensuite. Normales en espace vue et réflectivité complètent le rendu géométrique.
Sur ces deux pages, le mouvement géométrique est RG16F pour respecter le budget
MRT WebGPU par défaut. La profondeur géométrique conserve sa précision R32F
jusqu'au cœur. Une passe prépare une copie filtrable en RGBA16F de la profondeur
pour les effets natifs, avec un fond à 120 unités et une normale valide : cela
évite les reconstructions indéfinies à profondeur nulle dans le SSAO. Cette copie
réduit uniquement la précision des effets écran, dans la portée courte de la démo.
Le présentateur conserve explicitement ces dépendances jusqu'à la présentation,
y compris les textures relues par le combinateur de flou SSR de Babylon 9.29.

SSAO fournit de l'occlusion ambiante, pas l'éclairage indirect diffus SSGI des
exemples Three. SSR est limité aux surfaces visibles à l'écran. Le bloom est
spatial et l'upscaler reste l'unique reconstruction temporelle de cette pile.
Ces pages ne portent pas le débruiteur SSGI expérimental ni le path tracer Three.

Le chemin temporel expose `task.guides` : `dilatedDepth`, `dilatedMotion` et
`disocclusion`, trois handles stables appartenant au texture manager. Le masque
de disocclusion est dans R (`1` rejette l'historique) ; le mouvement est en UV
dans RG. La profondeur est l'historique **courant en écriture** : un consommateur
brut doit appeler `babylonWebGPU.resolveBabylonTexture(manager, handle, true)`.
Un consommateur Babylon doit également sélectionner `history.write`, et déclarer
tous les handles lus dans les dépendances de son render pass.

Pour consommer les guides avant l'upscale :

```ts
// Les entrées géométriques sont produites avant ces tâches.
graph.addTask(upscale.createGuidesTask());
graph.addTask(colorFromGuides); // lit upscale.guides et écrit sa propre couleur
upscale.colorTexture = colorFromGuides.outputTexture;
graph.addTask(upscale);
```

`createGuidesTask()` est idempotente et partage compilation et allocations avec
la tâche finale. Ajouter la tâche de guides avant le consommateur et l'upscaler
est obligatoire. Le callback `frame` est évalué à chaque étape : index, jitter
et géométrie doivent rester identiques ; la couleur et l'exposition peuvent être
finalisées après les guides. La tâche finale effectue uniquement l'étape upscale.
Sans tâche de guides, elle conserve son encodage complet habituel.

Encadrer l'exécution par `beginFrame(camera)` et `endFrame()` dans un `finally`.
Une interruption entre les étapes invalide l'historique à `endFrame()` ; sans ce
cadre, appeler `resetHistory()` avant réutilisation. Reconfigurer uniquement entre
frames, puis reconstruire le graphe. Le mode scindé nécessite le chemin temporel.
Piloter la désactivation via **la tâche upscale propriétaire** : les guides
continuent à être produits, la sortie utilise le fallback bilinéaire et la
réactivation repart avec un historique invalidé. Ne pas désactiver séparément
la tâche de guides.

L'exemple 29 affiche les textures effectivement publiées. L'exemple 30 applique
une teinte orange à basse résolution à partir du masque partagé ; c'est un effet
de diagnostic, pas un débruiteur. Désactiver la teinte conserve exactement la
couleur et l'alpha fournis à l'upscaler.

## Vérification des exemples

`npm run verify:babylon-examples:gpu` construit le site puis lance Chrome avec
WebGPU sur ce build. Il faut un navigateur et un GPU compatibles ; la commande
ne publie rien. Les résultats et captures sont écrits dans
`output/playwright/babylon-scenes/` (ignoré par Git). Elle accepte aussi un build
avec `PAGES_BASE=/upscaler/` pour vérifier les URL GitHub Pages.

Vérifié sur Chrome / RTX 5080 le 7 octobre 2026 : les douze pages rendent sans
erreur WebGPU, les sorties RGB et profondeurs sont finies, l'orientation verticale
est correcte, le mouvement statique exclut le jitter, et les mouvements de caméra
et de meshes sont présents. Les parcours masque activé/désactivé,
bilinéaire/temporel, reset, dimensions impaires, NativeAA et optimisation d'alias
activée/désactivée passent. La disposition mobile à 390 pixels a été vérifiée.
Le second lot ajoute les contrôles de sortie spatiale, de vignette activée et
neutre, de masque dessiné atteignant `1`, et d'alpha nul/opaque/fractionnaire.
Ces contrôles ne constituent ni une mesure de performance, ni une validation
sur un GPU mobile. Les douze pages ont ensuite été vérifiées sur RX 580 et
RTX 5080 les 9 et 10 octobre ; voir [les résultats et limites actuels](fork-validation.md).

Le troisième lot ajoute les bascules SSAO/SSR/bloom, la lecture des trois guides
et la composition avant upscale. Les effets sont comparés sans jitter sur une
scène figée ; le SSR utilise des moyennes RGB par zones pour détecter les reflets
même lorsque leur luminosité moyenne globale ne change presque pas. Les copies
de diagnostic sont toutes encodées avant le premier `await`, pour lire une même
frame. Le contrôle du mouvement dilaté porte sur RG (B contient le relief local).
La teinte neutre conserve exactement l'entrée. Les douze pages passent avec
optimisation d'alias active et inactive, puis à dimensions impaires et NativeAA.
