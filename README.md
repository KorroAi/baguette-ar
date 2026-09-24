# Baguette AR

Web app de dessin en réalité augmentée : tu dessines avec ton doigt sur l'écran, les traits 3D restent fixés dans la pièce et on peut tourner autour. Le mode **Surface** peint directement sur les murs, le sol et les objets.

En ligne : https://korroai.github.io/baguette-ar/

## Prérequis

- Android compatible ARCore + **Chrome** (et « Google Play Services for AR » à jour)
- Page servie en **HTTPS** (obligatoire pour la caméra / WebXR)

## Utilisation

- **Dans l'air** : glisse ton doigt sur l'écran, le trait apparaît sous ton doigt à la distance réglée (*Réglages → Distance*). Tu peux aussi marcher en dessinant.
- **Mode Surface** (bouton en haut) : le réticule montre la surface détectée. Glisse le doigt dessus : la peinture se plaque sur la surface, suit ses courbes, et reprend la lumière et la texture réelles grâce à l'image caméra (*Réglages → Réalisme surface*). Le trait reste collé à la surface touchée au départ.
- **Bombe** : sur une surface, trait diffus avec des coulures qui descendent (reste appuyé au même endroit pour faire couler). Dans l'air, nuage de peinture.
- **Formes** : choisis une forme, un fantôme blanc apparaît, touche l'écran pour la poser (à plat sur la surface en mode Surface).
- **Pinceaux** : Néon, Peinture, Bombe, Craie, Ruban, Flamme, Éclair, Pointillés, Étincelles, Perles.
- **Couleurs** : Arc-en-ciel, Irisé, Feu, Aurore, Or (animées, compatibles avec tous les pinceaux) + 10 couleurs unies.
- Boutons du haut : annuler, tout effacer, masquer l'interface (pour filmer avec l'enregistreur d'écran d'Android).

**Aperçu 3D sans AR** : sur ordinateur, clic gauche pour dessiner, clic droit pour tourner, molette pour zoomer. En mode Surface, un mur, un sol et une boule factices servent de support.

## Lancer en local (aperçu ordinateur)

```bash
cd baguette-ar
python -m http.server 8765
# puis http://localhost:8765
```

## Structure

```
index.html        page + interface (overlay WebXR)
style.css         styles
js/main.js        session AR, doigt / hit-test surfaces, image caméra, interface
js/brushes.js     géométries des traits, shaders animés, bombe et coulures
js/shapes.js      formes prêtes à poser
```

Aucune étape de build : Three.js (0.170) est chargé depuis jsDelivr via importmap.

## Notes techniques

- Dessin au doigt : pose de la source d'entrée WebXR `screen` (`targetRaySpace`).
- Surfaces : hit-test WebXR (`requestHitTestSourceForTransientInput`) plans + points caractéristiques ARCore.
- Réalisme : `camera-access` (`XRWebGLBinding.getCameraImage`), la peinture est modulée par la luminance de l'image caméra. Si la texture paraît inversée, cocher *Réglages → Inverser la texture caméra*.
