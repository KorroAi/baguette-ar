# Baguette AR

Web app de dessin en réalité augmentée : le téléphone sert de baguette magique, les traits 3D restent fixés dans la pièce et on peut tourner autour.

## Prérequis

- Android compatible ARCore + **Chrome**
- Page servie en **HTTPS** (obligatoire pour la caméra / WebXR)

## Utilisation

- **Main libre** : maintiens l'écran appuyé et bouge le téléphone. Le trait sort d'un point situé devant la caméra (réglable dans *Réglages → Distance*).
- **Formes** : choisis une forme, un fantôme blanc apparaît devant toi, touche l'écran pour la poser.
- **Pinceaux** : Néon (halo pulsant), Peinture, Ruban (toujours tourné vers toi), Pointillés animés, Étincelles scintillantes, Perles qui respirent.
- **Couleurs** : 9 couleurs + arc-en-ciel animé (marche avec tous les pinceaux).
- Boutons du haut : annuler, tout effacer, masquer l'interface (pour filmer).
- Pour filmer : utilise l'enregistreur d'écran d'Android (la caméra AR n'est pas capturable depuis la page).

**Aperçu 3D sans AR** : sur ordinateur, clic gauche pour dessiner, clic droit pour tourner, molette pour zoomer.

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
js/main.js        session AR, pose du téléphone, entrées, interface
js/brushes.js     géométries des traits + shaders animés
js/shapes.js      formes prêtes à poser
```

Aucune étape de build : Three.js (0.170) est chargé depuis jsDelivr via importmap.
